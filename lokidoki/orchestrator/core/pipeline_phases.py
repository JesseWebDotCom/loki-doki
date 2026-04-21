"""Pipeline phase helpers — extracted from pipeline.py for file size.

Each function runs one phase of the pipeline (routing, derivation,
resolution, execution, synthesis) and produces trace entries.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters import adapt
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_hooks import (
    auto_raise_need_session_context,
    record_behavior_event,
    record_sentiment,
    run_session_state_update,
)
from lokidoki.orchestrator.core.pipeline_memory import (
    run_memory_read_path,
    run_memory_write_path,
)
from lokidoki.orchestrator.decomposer import (
    RouteDecomposition,
    decompose_for_routing,
)
from lokidoki.orchestrator.execution.executor import execute_chunk_async
from lokidoki.orchestrator.execution.request_spec import build_request_spec
from lokidoki.orchestrator.fallbacks.llm_fallback import decide_llm, llm_synthesize_async
from lokidoki.orchestrator.media import augment_with_media
from lokidoki.orchestrator.core.types import ConstraintResult, ExecutionResult
from lokidoki.orchestrator.pipeline.combiner import combine_request_spec
from lokidoki.orchestrator.pipeline.derivations import derive_need_flags, extract_structured_params
from lokidoki.orchestrator.pipeline.constraint_extractor import extract_constraints
from lokidoki.orchestrator.pipeline.entity_aliases import canonicalize_entities
from lokidoki.orchestrator.pipeline.extractor import extract_chunk_data
from lokidoki.orchestrator.pipeline.fast_lane import check_fast_lane
from lokidoki.orchestrator.pipeline.goal_inference import infer_goal
from lokidoki.orchestrator.pipeline.normalizer import normalize_text
from lokidoki.orchestrator.pipeline.parser import parse_text
from lokidoki.orchestrator.pipeline.splitter import split_requests
from lokidoki.orchestrator.resolution.resolver import resolve_chunk_async
from lokidoki.orchestrator.routing.router import route_chunk_async
from lokidoki.orchestrator.signals.interaction_signals import detect_interaction_signals

logger = logging.getLogger("lokidoki.orchestrator.core.pipeline")


def run_pre_parse_phase(trace, safe_context, raw_text):
    """Run normalize -> signals -> fast_lane."""
    finish = trace.timed("normalize")
    normalized = normalize_text(raw_text)
    finish(cleaned_text=normalized.cleaned_text)

    finish = trace.timed("signals")
    signals = detect_interaction_signals(normalized.cleaned_text)
    finish(interaction_signal=signals.interaction_signal,
           tone_signal=signals.tone_signal, urgency=signals.urgency)

    finish = trace.timed("fast_lane")
    fast_lane = check_fast_lane(normalized.cleaned_text)
    finish(matched=fast_lane.matched, capability=fast_lane.capability,
           reason=fast_lane.reason,
           status="matched" if fast_lane.matched else "bypassed")
    return normalized, signals, fast_lane


def run_initial_phase(trace, safe_context, raw_text, normalized):
    """Run parse -> split -> extract -> memory_write."""
    finish = trace.timed("parse")
    parsed = parse_text(normalized.cleaned_text)
    logger.debug("[Pipeline] Parsed tokens: %d", parsed.token_count)
    finish(token_count=parsed.token_count, sentences=parsed.sentences,
           parser=parsed.parser, entity_count=len(parsed.entities),
           noun_chunk_count=len(parsed.noun_chunks))

    finish = trace.timed("split")
    chunks = split_requests(parsed)
    finish(count=len(chunks), chunks=[c.text for c in chunks],
           roles=[c.role for c in chunks])

    finish = trace.timed("extract")
    extractions = extract_chunk_data(chunks, parsed)
    finish(references=[i.references for i in extractions],
           predicates=[i.predicates for i in extractions],
           entities=[i.entities for i in extractions])

    finish = trace.timed("canonicalize")
    for ext in extractions:
        _, ext.entities = canonicalize_entities("", ext.entities)
    finish(count=len(extractions))

    finish = trace.timed("constraints")
    constraints = extract_constraints(parsed.doc, normalized.cleaned_text)
    finish(budget_max=constraints.budget_max,
           time_constraint=constraints.time_constraint,
           is_comparison=constraints.is_comparison,
           is_recommendation=constraints.is_recommendation,
           negations=constraints.negations,
           quantity=constraints.quantity)

    finish = trace.timed("memory_write")
    memory_write_result = run_memory_write_path(parsed, chunks, safe_context)
    finish(accepted=len(memory_write_result.accepted),
           rejected=len(memory_write_result.rejected))
    return parsed, chunks, extractions, constraints, memory_write_result


async def run_routing_phase(trace, safe_context, routable, runtime, routable_extractions=None):
    """Route each routable chunk and select its implementation.

    Fires the decomposer (fast LLM capability_need extractor) in parallel
    with MiniLM cosine scoring. The decomposer's output becomes a
    per-capability boost in :func:`route_chunk`, tipping borderline
    matches without overriding confident wins. If the decomposer times
    out or errors, its result is a no-op fallback and routing proceeds
    on MiniLM alone.
    """
    # Combine routable chunk text for one decomposer call. The
    # decomposer operates on user intent, which is usually unified
    # across a multi-sentence utterance; per-chunk calls would just
    # triple latency for no accuracy gain.
    combined_text = " ".join(c.text for c in routable).strip()
    decompose_task = asyncio.create_task(decompose_for_routing(combined_text))

    finish = trace.timed("route")
    ext_by_chunk = {ext.chunk_index: ext for ext in (routable_extractions or [])}
    # Wait for decomposer alongside the cosine lookups. Both are awaitable,
    # so gather schedules them concurrently — decomposer network I/O
    # overlaps with MiniLM to_thread() CPU work.
    routing_tasks = [
        _timed_route(
            c, runtime,
            entities=(ext_by_chunk.get(c.index, None) and ext_by_chunk[c.index].entities) or None,
            decompose_task=decompose_task,
        )
        for c in routable
    ]
    routed = list(await asyncio.gather(*routing_tasks))
    routes = [item["route"] for item in routed]
    # Every _timed_route awaited the same decompose_task, so it's done
    # by now — pull the result for observability.
    decomposition = decompose_task.result() if decompose_task.done() else RouteDecomposition()
    safe_context["route_decomposition"] = decomposition
    for r in routes:
        logger.debug("[Pipeline] Routed chunk %d to %s (conf=%s)",
                     r.chunk_index, r.capability, r.confidence)
    finish(
        chunks=[
            {"chunk_index": item["route"].chunk_index, "text": c.text,
             "capability": item["route"].capability,
             "confidence": item["route"].confidence,
             "matched_text": item["route"].matched_text,
             "timing_ms": item["timing_ms"]}
            for c, item in zip(routable, routed, strict=True)
        ],
        decomposer_source=decomposition.source,
        decomposer_capability_need=decomposition.capability_need,
        decomposer_archive_hint=decomposition.archive_hint,
        decomposer_latency_ms=decomposition.latency_ms,
    )

    finish = trace.timed("select_implementation")
    selected = list(await asyncio.gather(*(
        _timed_select(c.index, r.capability, runtime)
        for c, r in zip(routable, routes, strict=True)
    )))
    implementations = [item["implementation"] for item in selected]
    finish(chunks=[
        {"chunk_index": item["implementation"].chunk_index, "text": c.text,
         "capability": item["implementation"].capability,
         "handler_name": item["implementation"].handler_name,
         "implementation_id": item["implementation"].implementation_id,
         "priority": item["implementation"].priority,
         "candidate_count": item["implementation"].candidate_count,
         "candidates": item["candidates"],
         "timing_ms": item["timing_ms"]}
        for c, item in zip(routable, selected, strict=True)
    ])
    return routes, implementations


def run_derivations_phase(trace, safe_context, parsed, chunks, extractions, routes):
    """Derive need flags from parse + route results.

    Note: ``bridge_session_state_to_recent_entities`` now runs at pipeline
    start (before antecedent resolution) so that the pre-routing resolver
    can read session-state entities.  It is NOT called here anymore.
    """
    finish = trace.timed("derive_flags")
    derived = derive_need_flags(parsed, chunks, extractions, routes, safe_context)
    for key, value in derived.items():
        safe_context.setdefault(key, value)
    derived_params = extract_structured_params(chunks, extractions, routes)
    finish(flags=sorted(derived.keys()), params_chunks=sorted(derived_params.keys()))

    finish = trace.timed("goal_inference")
    constraints = safe_context.get("constraints", ConstraintResult())
    if not isinstance(constraints, ConstraintResult):
        constraints = ConstraintResult()
    features: dict = {}
    text = " ".join(c.text for c in chunks) if chunks else ""
    likely_goal = infer_goal(constraints, features, routes, text)
    safe_context["likely_goal"] = likely_goal
    finish(likely_goal=likely_goal)

    return derived_params


async def run_resolve_phase(trace, safe_context, routable, routable_extractions, routes, derived_params):
    """Run the resolve step and merge derived params."""
    finish = trace.timed("resolve")
    resolved = list(await asyncio.gather(*(
        _timed_resolve(c, e, r, safe_context)
        for c, e, r in zip(routable, routable_extractions, routes, strict=True)
    )))
    resolutions = [item["resolution"] for item in resolved]
    for resolution in resolutions:
        chunk_params = derived_params.get(resolution.chunk_index)
        if chunk_params:
            for key, value in chunk_params.items():
                resolution.params.setdefault(key, value)
    finish(chunks=[
        {"chunk_index": item["resolution"].chunk_index, "text": c.text,
         "resolved_target": item["resolution"].resolved_target,
         "source": item["resolution"].source,
         "confidence": item["resolution"].confidence,
         "context_value": item["resolution"].context_value,
         "candidate_values": item["resolution"].candidate_values,
         "unresolved": item["resolution"].unresolved,
         "params": item["resolution"].params,
         "timing_ms": item["timing_ms"]}
        for c, item in zip(routable, resolved, strict=True)
    ])
    return resolutions


async def run_execute_phase(trace, safe_context, runtime, routable, routes, implementations, resolutions):
    """Run the execute step."""
    finish = trace.timed("execute")
    budgets = [
        (runtime.capabilities.get(r.capability) or {}).get("max_chunk_budget_ms")
        for r in routes
    ]
    executed = list(await asyncio.gather(*(
        _timed_execute(c, r, impl, res, budget_ms=b, context=safe_context)
        for c, r, impl, res, b in zip(routable, routes, implementations, resolutions, budgets, strict=True)
    )))
    executions = [item["execution"] for item in executed]
    for execution, implementation in zip(executions, implementations, strict=True):
        if not execution.success:
            continue
        if not implementation.skill_id:
            # No adapter can run without a registered skill_id. Skill
            # implementations missing this field are a registry bug —
            # log once so the omission is visible in telemetry, but
            # don't break the turn.
            logger.debug(
                "adapter skipped: implementation %s has no skill_id",
                implementation.handler_name,
            )
            continue
        mechanism_result = _mechanism_result_from_execution(execution)
        execution.adapter_output = adapt(implementation.skill_id, mechanism_result)
    for ex in executions:
        logger.debug("[Pipeline] Executed %s (success=%s)", ex.capability, ex.success)
    finish(chunks=[
        {"chunk_index": item["execution"].chunk_index, "text": c.text,
         "capability": item["execution"].capability,
         "output_text": item["execution"].output_text,
         "success": item["execution"].success,
         "error": item["execution"].error,
         "attempts": item["execution"].attempts,
         "timing_ms": item["timing_ms"]}
        for c, item in zip(routable, executed, strict=True)
    ])
    return executions


def _apply_adapter_outputs_to_spec(request_spec, executions: list[ExecutionResult]) -> None:
    """Aggregate adapter sources + facts onto the spec.

    Part of chunk 5's "adapter-first" cutover. Sources flow to
    ``request_spec.adapter_sources`` (the shape ``_collect_sources``
    consumes); facts flow to ``request_spec.supporting_context`` so the
    synthesis prompt can lean on them without adding a new slot.
    ``request_spec.media`` is populated separately by
    :func:`run_media_augmentation_phase`.
    """
    adapter_sources: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    extra_facts: list[str] = []
    for execution in executions:
        adapter_output: AdapterOutput | None = execution.adapter_output
        if adapter_output is None:
            continue
        for source in adapter_output.sources:
            entry = _source_to_dict(source)
            url = entry.get("url") or ""
            if url and url in seen_urls:
                continue
            if url:
                seen_urls.add(url)
            adapter_sources.append(entry)
        for fact in adapter_output.facts:
            text = str(fact).strip()
            if text and text not in extra_facts:
                extra_facts.append(text)
    request_spec.adapter_sources = adapter_sources
    if extra_facts:
        existing = list(request_spec.supporting_context or [])
        merged = list(existing)
        for fact in extra_facts:
            if fact not in merged:
                merged.append(fact)
        request_spec.supporting_context = merged


def _source_to_dict(source: Source) -> dict[str, str]:
    """Serialize a Source dataclass into the dict shape prompt code expects."""
    entry: dict[str, str] = {
        "title": source.title or "",
        "url": source.url or "",
    }
    if source.kind:
        entry["type"] = source.kind
    if source.snippet:
        entry["snippet"] = source.snippet
    if source.published_at:
        entry["published_at"] = source.published_at
    if source.author:
        entry["author"] = source.author
    return entry


def _mechanism_result_from_execution(execution) -> MechanismResult:
    raw = execution.raw_result if isinstance(execution.raw_result, dict) else {}
    data = raw.get("data")
    payload = data if isinstance(data, dict) else {}
    return MechanismResult(
        success=execution.success,
        data=payload,
        error=str(raw.get("error") or execution.error or ""),
        source_url=str(raw.get("source_url") or ""),
        source_title=str(raw.get("source_title") or ""),
    )


def build_and_annotate_spec(trace, safe_context, raw_text, chunks, routes,
                            implementations, resolutions, executions, signals,
                            extractions=None):
    """Build request spec and run post-execution hooks."""
    finish = trace.timed("request_spec")
    request_spec = build_request_spec(
        raw_text=raw_text, chunks=chunks, routes=routes,
        implementations=implementations, resolutions=resolutions,
        executions=executions, context=safe_context, trace_id=trace.trace_id,
    )
    finish(chunk_count=len(request_spec.chunks), trace_id=request_spec.trace_id)

    # Re-derive goal now that execution results are available.
    constraints = safe_context.get("constraints", ConstraintResult())
    if not isinstance(constraints, ConstraintResult):
        constraints = ConstraintResult()
    features: dict = {}
    if any(ex.success for ex in executions):
        features["has_execution_result"] = True
    likely_goal = infer_goal(constraints, features, routes, raw_text)
    safe_context["likely_goal"] = likely_goal

    run_session_state_update(
        safe_context, resolutions, executions,
        routes=routes, extractions=extractions,
    )
    auto_raise_need_session_context(safe_context, resolutions)
    record_behavior_event(safe_context, executions, routes)
    record_sentiment(safe_context, signals)
    return request_spec


_MEDIA_AUGMENT_TIMEOUT_S = 6.0


async def run_media_augmentation_phase(trace, chunks, routes, executions, raw_text=""):
    """Collect media cards for the turn — adapter-first, augmentor-fallback.

    Pass 1 (canonical): flatten ``execution.adapter_output.media`` across
    every successful primary-request execution. When the skill's adapter
    already produced a ``MediaCard``-shaped dict (YouTube, TMDB movies)
    there is no need to re-derive anything.

    Pass 2 (fallback): when Pass 1 produced nothing, run the legacy
    :func:`augment_with_media` path. This is kept for one release cycle
    so we aren't betting correctness on brand-new adapter coverage
    alone. A warning fires when the fallback activates so we can spot
    skills whose adapter under-populates media.

    Runs best-effort — failures and the 6s timeout both degrade to an
    empty list rather than breaking the turn.
    """
    finish = trace.timed("media_augment")
    cards = _media_cards_from_adapters(executions)
    used_fallback = False
    if not cards:
        try:
            cards = await asyncio.wait_for(
                augment_with_media(chunks, routes, executions, raw_text=raw_text),
                timeout=_MEDIA_AUGMENT_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.warning("media augmentation timed out after %ss", _MEDIA_AUGMENT_TIMEOUT_S)
            cards = []
        except Exception:  # noqa: BLE001 - augmentation must never break pipeline
            logger.exception("media augmentation raised")
            cards = []
        else:
            used_fallback = True
    if used_fallback and cards:
        logger.warning(
            "media augmentation used legacy fallback (adapter_output.media was empty); "
            "%d card(s) surfaced",
            len(cards),
        )
    finish(
        count=len(cards),
        kinds=[c.get("kind") for c in cards],
        source="adapters" if not used_fallback else "fallback",
    )
    return cards


def _media_cards_from_adapters(executions: list[ExecutionResult]) -> list[dict[str, Any]]:
    """Flatten adapter-provided media cards, deduping by url/video_id."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for execution in executions:
        adapter_output: AdapterOutput | None = execution.adapter_output
        if adapter_output is None:
            continue
        for card in adapter_output.media:
            if not isinstance(card, dict):
                continue
            key = str(card.get("url") or card.get("video_id") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            out.append(card)
    return out


async def run_synthesis_phase(trace, safe_context, raw_text, request_spec, executions, memory_write_result, runtime):
    """Read memory slots, decide LLM usage, produce final response."""
    finish = trace.timed("memory_read")
    memory_slots = run_memory_read_path(raw_text, safe_context)
    if memory_slots:
        request_spec.context.setdefault("memory_slots", {}).update(memory_slots)
    finish(slots_assembled=sorted(memory_slots.keys()),
           **{f"{k}_chars": len(v) for k, v in memory_slots.items()})

    # Cutover: sources + facts are read from execution.adapter_output
    # now, not re-scraped from each skill's dict. Writes land on the
    # spec so _collect_sources + synthesis prompt pick them up without
    # per-skill branches.
    _apply_adapter_outputs_to_spec(request_spec, executions)

    decision = decide_llm(request_spec)
    request_spec.llm_used = decision.needed
    request_spec.llm_reason = decision.reason

    finish = trace.timed("combine")
    if decision.needed:
        response = await llm_synthesize_async(request_spec)
        
        # Phase 1 Loop: Check for knowledge gap marker
        if "[[NEED_SEARCH:" in response.output_text:
            response = await _handle_knowledge_gap(
                trace, safe_context, raw_text, request_spec, executions, response, runtime
            )
            
        finish(mode="llm", reason=decision.reason, output_text=response.output_text)
    else:
        response = combine_request_spec(request_spec)
        finish(mode="deterministic", output_text=response.output_text)
    return response


async def _handle_knowledge_gap(trace, safe_context, raw_text, request_spec, executions, initial_response, runtime):
    """Fallback search loop triggered by LLM honesty marker or phrase detection."""
    import re
    from lokidoki.orchestrator.core.types import RequestChunk, RouteMatch, ResolutionResult
    
    text = initial_response.output_text
    query = None
    
    # Pattern 1: Explicit marker (high confidence)
    match = re.search(r"\[\[NEED_SEARCH:\s*(.*?)\s*\]\]", text)
    if match:
        query = match.group(1)
        logger.info("[Loop] LLM requested search via marker: '%s'", query)
    
    # Pattern 2: Natural language admission of ignorance (fallback)
    # Catches cases where the small model ignores the [[NEED_SEARCH:]] instruction
    # and instead says "I'm not familiar with X" or hedges with uncertainty.
    if not query:
        ignorance_patterns = [
            r"not familiar with\s+[\"']?(.*?)[\"']?\s+as",
            r"not familiar with\s+[\"']?(.*?)[\"']?[\.\!\,]",
            r"don't know\s+(?:much\s+)?about\s+[\"']?(.*?)[\"']?[\.\!\,]",
            r"don't have\s+(?:any\s+)?information\s+(?:on|about)\s+[\"']?(.*?)[\"']?[\.\!\,]",
            r"not sure (?:what|about)\s+[\"']?(.*?)[\"']?\s+is",
            r"can't confirm\s+(?:what|whether)\s+[\"']?(.*?)[\"']?",
            r"haven't heard of\s+[\"']?(.*?)[\"']?[\.\!\,]",
            r"no information (?:on|about)\s+[\"']?(.*?)[\"']?[\.\!\,]",
        ]
        for pattern in ignorance_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                candidate = match.group(1).strip().strip("\"'").strip()
                if candidate and len(candidate) < 100:
                    query = candidate
                    logger.info("[Loop] Detected ignorance phrase. Falling back to search for: '%s'", query)
                    break

                    
    if not query:
        return initial_response

    # Contextualize vague queries using conversation history.
    # "is it free" alone would search for "free" — but with context we get
    # "is Claude Cowork free" which returns relevant results.
    query = _contextualize_query(query, raw_text, safe_context)

    # Emit an interim "looking it up" event so the UI shows a placeholder
    # while the web search runs.  The final synthesis:done event replaces it.
    # TTS must NOT speak this — it is marked with `interim: true`.
    _emit_interim_lookup(safe_context, query)

    # 1. Log for manual review (Step 2)
    _log_knowledge_gap(raw_text, query, safe_context)

    # 2. Build a synthetic search execution
    chunk = RequestChunk(text=query, index=999, role="primary_request")
    route = RouteMatch(chunk_index=999, capability="search_web", confidence=1.0, matched_text=query)
    implementation = runtime.select_handler(999, "search_web")
    resolution = ResolutionResult(
        chunk_index=999, 
        resolved_target=query, 
        source="loop", 
        confidence=1.0, 
        params={"query": query}
    )
    
    # 3. Execute the search
    finish = trace.timed("loop_execute_search")
    execution = await execute_chunk_async(
        chunk, route, implementation, resolution, budget_ms=8000, context=safe_context
    )
    finish(success=execution.success, query=query)
    
    if not execution.success:
        logger.warning("[Loop] Fallback search failed for '%s'", query)
        return initial_response
        
    # 3. Inject into trace so it shows up in the UI (routing_log)
    # Since these phases already 'finished', we surgically update their details
    route_step = next((s for s in trace.steps if s.name == "route"), None)
    if route_step:
        route_chunks = route_step.details.setdefault("chunks", [])
        if not any(c.get("chunk_index") == 999 for c in route_chunks):
            route_chunks.append({
                "chunk_index": 999,
                "text": query,
                "capability": "search_web",
                "confidence": 1.0,
                "matched_text": query,
                "timing_ms": 0.0
            })
            
    execute_step = next((s for s in trace.steps if s.name == "execute"), None)
    if execute_step:
        exec_chunks = execute_step.details.setdefault("chunks", [])
        if not any(c.get("chunk_index") == 999 for c in exec_chunks):
            # We use the raw_result metadata or similar for timing if available
            timing = execution.raw_result.get("latency_ms", 0) if isinstance(execution.raw_result, dict) else 0
            exec_chunks.append({
                "chunk_index": 999,
                "text": query,
                "capability": "search_web",
                "output_text": execution.output_text,
                "success": execution.success,
                "error": None,
                "attempts": 1,
                "timing_ms": timing
            })

    # 4. Integrate result into spec and re-synthesize
    # We create a new RequestChunkResult so the synthesis prompt builder 
    # gets the fields it expects (role, unresolved, etc.)
    from lokidoki.orchestrator.core.types import RequestChunkResult
    res_chunk = RequestChunkResult(
        text=query,
        role="primary_request",
        capability="search_web",
        confidence=1.0,
        handler_name=execution.handler_name,
        implementation_id=implementation.implementation_id,
        params={"query": query},
        result=execution.raw_result,
        success=execution.success,
        error=execution.error
    )
    executions.append(execution)
    request_spec.chunks.append(res_chunk)
    
    # Force the LLM to ignore the previous marker by appending a system hint if needed,
    # but build_combine_prompt usually handles the whole Spec.
    # We clear the previous "direct_chat" reason to ensure a full combine.
    request_spec.llm_reason = "knowledge_gap_recovery"
    
    logger.info("[Loop] Re-synthesizing with search results...")
    return await llm_synthesize_async(request_spec)


def _contextualize_query(query: str, raw_text: str, safe_context: dict) -> str:
    """Enrich a vague search query with conversational context.

    When the LLM emits ``[[NEED_SEARCH: is it free]]``, the bare query
    "is it free" will return irrelevant results. Uses the same antecedent
    resolver the main pipeline uses to replace pronouns with the most
    recent entity (falling back to the broader topic).
    """
    from lokidoki.orchestrator.pipeline.antecedent import (
        _resolve_entity_and_topic,
        _try_resolve,
    )
    entity, topic = _resolve_entity_and_topic(safe_context)
    referent = entity or topic
    if referent:
        resolved = _try_resolve(query, referent)
        if resolved != query:
            logger.info("[Loop] Contextualized query: '%s' → '%s'", query, resolved)
            return resolved
    # Fallback: only prepend raw_text when the extracted query is
    # genuinely short / vague (4 words or fewer). A complete question
    # like "who is the active us president" must NOT get a prior turn's
    # text appended — that produced garbled search queries like
    # "who is the active us president what's happening".
    query_words = query.split()
    if (
        len(query_words) <= 4
        and raw_text.strip().lower() != query.strip().lower()
    ):
        enriched = f"{raw_text.strip()} {query}"
        if len(enriched) > 120:
            enriched = enriched[:120]
        logger.info("[Loop] Contextualized query (fallback): '%s' → '%s'", query, enriched)
        return enriched
    return query


def _emit_interim_lookup(safe_context: dict, query: str) -> None:
    """Push an interim SSE event so the frontend shows a placeholder response.

    The event carries ``interim: true`` so the frontend knows:
    1. Replace the streaming bubble text with this message.
    2. Do NOT trigger TTS for this text.
    The subsequent ``synthesis:done`` event overwrites it with the real answer.
    """
    queue = safe_context.get("_sse_queue")
    if queue is None:
        return
    from lokidoki.orchestrator.core.streaming import SSEEvent
    queue.put_nowait(SSEEvent(
        phase="synthesis",
        status="interim",
        data={"response": "Let me look that up\u2026", "interim": True, "query": query},
    ))
    logger.info("[Loop] Emitted interim lookup event for '%s'", query)


def _log_knowledge_gap(original_input: str, resolved_query: str, context: dict):
    """Log failures for Phase 2 manual review."""
    user_id = context.get("owner_user_id", "unknown")
    entry = {
        "user_id": user_id,
        "input": original_input,
        "query": resolved_query,
        "timestamp": time.time(),
        "type": "knowledge_gap"
    }
    # For now, we just dump to logs. Later this could go to a 'data/knowledge_gaps.json' 
    # for the Admin panel to read.
    logger.warning("[Step 2] KNOWLEDGE_GAP_LOG: %s", json.dumps(entry))
    
    # Also append to a persistent file for administrative review
    try:
        log_path = "data/knowledge_gaps.jsonl"
        with open(log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        logger.exception("Failed to write knowledge gap to persistent file")


# ---- timed wrappers ---------------------------------------------------------

async def _timed_route(chunk, runtime, entities=None, decompose_task=None):
    """Run one chunk's routing after awaiting the (shared) decomposer task.

    All chunks await the SAME task, so the decomposer only runs once
    per turn even when there are multiple routable chunks. The await is
    cheap once the task is complete.
    """
    started = time.perf_counter()
    decomposition = None
    if decompose_task is not None:
        try:
            decomposition = await decompose_task
        except Exception:  # noqa: BLE001 — decomposer must never break routing
            decomposition = None
    route = await route_chunk_async(
        chunk, runtime,
        extracted_entities=entities,
        decomposition=decomposition,
    )
    return {"route": route, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}


async def _timed_select(chunk_index, capability, runtime):
    started = time.perf_counter()
    implementation = runtime.select_handler(chunk_index, capability)
    candidates = sorted(
        [{"id": str(item.get("id") or ""),
          "handler_name": str(item.get("handler_name") or ""),
          "priority": int(item.get("priority", 999)),
          "enabled": bool(item.get("enabled", True))}
         for item in (runtime.capabilities.get(capability) or {}).get("implementations", [])
         if item.get("enabled", True)],
        key=lambda item: item["priority"],
    )
    return {"implementation": implementation, "candidates": candidates,
            "timing_ms": round((time.perf_counter() - started) * 1000, 3)}


async def _timed_resolve(chunk, extraction, route, context):
    started = time.perf_counter()
    resolution = await resolve_chunk_async(chunk, extraction, route, context)
    return {"resolution": resolution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}


async def _timed_execute(chunk, route, implementation, resolution, *, budget_ms=None, context=None):
    started = time.perf_counter()
    execution = await execute_chunk_async(chunk, route, implementation, resolution, budget_ms=budget_ms, context=context)
    return {"execution": execution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}
