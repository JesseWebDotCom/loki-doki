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
from lokidoki.orchestrator.documents.extraction import estimate_tokens as _estimate_doc_tokens
from lokidoki.orchestrator.documents.extraction import extract_text as _extract_doc_text
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
from lokidoki.orchestrator.response import (
    Block,
    BlockState,
    BlockType,
    EnvelopeValidationError,
    ResponseEnvelope,
    validate_envelope,
)
from lokidoki.orchestrator.response import events as response_events
from lokidoki.orchestrator.response.mode import (
    PlannerInputs,
    VALID_MODES,
    derive_response_mode,
)
from lokidoki.orchestrator.response.artifact_trigger import should_use_artifact_mode
from lokidoki.orchestrator.response.planner import is_offline_degraded, plan_initial_blocks
from lokidoki.orchestrator.response.spoken import resolve_spoken_text
from lokidoki.orchestrator.response.status_strings import (
    FINISHING_PHRASE,
    phrase_for as status_phrase_for,
)
from lokidoki.orchestrator.response.synthesis_blocks import populate_text_blocks
from lokidoki.orchestrator.routing.router import route_chunk_async
from lokidoki.orchestrator.signals.interaction_signals import detect_interaction_signals

logger = logging.getLogger("lokidoki.orchestrator.core.pipeline")


_STATUS_TRANSITIONS_KEY = "_status_transitions"
_CLARIFICATION_KEY = "clarification_question_text"


def emit_status_patch(safe_context: dict, phase_key: str) -> None:
    """Record a phase transition for the live ``status`` block.

    Chunk 15 wiring. The canonical ``status`` block is pre-allocated
    by the planner (see
    :mod:`lokidoki.orchestrator.response.planner`). Here we just
    capture the phrase on ``safe_context`` so
    :func:`_emit_envelope_events` can replay the phrase trajectory as
    ``block_patch`` events after ``response_init`` lands.

    Why buffer instead of emitting inline? ``response_init`` is the
    SSE event that bootstraps the frontend envelope; the reducer
    drops every ``block_*`` event that arrives before it. Early
    phase transitions (``augmentation``, ``decomposition``,
    ``routing``) fire long before synthesis runs, so their patches
    would be discarded if emitted inline. Buffering keeps the
    history intact so the final snapshot — and any replay — still
    reflects the phase trajectory.

    Unknown phase keys are silently ignored so we don't drop a
    previous phrase by accident.
    """
    phrase = status_phrase_for(phase_key)
    if phrase is None:
        return
    transitions = safe_context.setdefault(_STATUS_TRANSITIONS_KEY, [])
    # Collapse consecutive duplicates — if two sub-steps both roll
    # up to the same user-visible phase (e.g. ``parse`` /
    # ``extract`` both live under "decomposition"), we only want one
    # patch.
    if transitions and transitions[-1] == phrase:
        return
    transitions.append(phrase)


def mark_status_finishing(safe_context: dict) -> None:
    """Swap the live status phrase to :data:`FINISHING_PHRASE`.

    Called when any block in the turn fails — the design doc is
    explicit that the status line shouldn't double-report errors
    (failures surface on the failing block itself).
    """
    transitions = safe_context.setdefault(_STATUS_TRANSITIONS_KEY, [])
    if transitions and transitions[-1] == FINISHING_PHRASE:
        return
    transitions.append(FINISHING_PHRASE)


def run_pre_parse_phase(trace, safe_context, raw_text):
    """Run normalize -> signals -> fast_lane."""
    # Chunk 15: first user-visible phase is "decomposition" (the
    # user's ask is being understood). Record so the ``status``
    # block eventually gets the right leading phrase.
    emit_status_patch(safe_context, "decomposition")

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
    # Chunk 15 status patch — memory work rolls up into the user-visible
    # "augmentation" phase (rendered as "Looking up context").
    emit_status_patch(safe_context, "augmentation")
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
    # Chunk 15: user-visible phase flips to "routing" here. The
    # decomposer fires below but rolls up into the routing bucket
    # from the user's point of view.
    emit_status_patch(safe_context, "routing")

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
    # Chunk 15: user-visible phase flips to "execute" (rendered as
    # "Checking sources" for skill/web execution).
    emit_status_patch(safe_context, "execute")

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


_DOCUMENT_CAPABILITY = "document_attachment"


def _apply_attached_document(
    safe_context: dict,
    request_spec,
    executions: list[ExecutionResult],
    raw_text: str,
) -> None:
    """Run the document adapter when the turn carries an attached file.

    Reads :py:`safe_context["attached_document"]` which, when present,
    carries at minimum ``{"path": str, "kind": str}`` — extra keys
    (``size_bytes``, ``estimated_tokens``) override the cheap
    estimators. Stamps ``safe_context["document_mode"]`` so
    :func:`_build_envelope` can surface it on the envelope.

    No-op when the key is absent or the payload is malformed; the
    pipeline stays additive for every non-document turn.
    """
    payload = safe_context.get("attached_document")
    if not isinstance(payload, dict):
        return
    path = str(payload.get("path") or "").strip()
    kind = str(payload.get("kind") or "").strip().lower().lstrip(".")
    if not path or kind not in ("pdf", "txt", "md", "docx"):
        return

    estimated_tokens = payload.get("estimated_tokens")
    if not isinstance(estimated_tokens, int) or estimated_tokens <= 0:
        estimated_tokens = _estimate_doc_tokens(_extract_doc_text(path, kind))
    size_bytes = payload.get("size_bytes")
    if not isinstance(size_bytes, int):
        size_bytes = 0

    distilled = str(
        (safe_context.get("route_decomposition") and
         getattr(safe_context["route_decomposition"], "distilled_query", "")) or ""
    ).strip()
    query = distilled or raw_text

    mechanism = MechanismResult(
        success=True,
        data={
            "path": path,
            "kind": kind,
            "size_bytes": size_bytes,
            "estimated_tokens": estimated_tokens,
            "query": query,
            "profile": safe_context.get("platform_profile"),
        },
    )
    output = adapt("document", mechanism)
    raw = output.raw if isinstance(output.raw, dict) else {}
    mode = raw.get("document_mode")
    if mode in ("inline", "retrieval"):
        safe_context["document_mode"] = mode

    synthetic = ExecutionResult(
        chunk_index=-1,
        capability=_DOCUMENT_CAPABILITY,
        output_text="",
        success=True,
        handler_name="document",
        raw_result={"data": mechanism.data},
        adapter_output=output,
    )
    executions.append(synthetic)


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


async def run_media_augmentation_phase(trace, chunks, routes, executions, raw_text="", safe_context=None):
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
    # Chunk 15: user-visible phase is "media_augment" (rendered as
    # "Looking for visuals"). ``safe_context`` is optional so tests
    # that exercise this helper standalone don't have to wire it.
    if safe_context is not None:
        emit_status_patch(safe_context, "media_augment")

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
    """Read memory slots, decide LLM usage, produce final response.
    """
    # Chunk 15: user-visible phase flips to "synthesis" for the
    # final summarization step.
    emit_status_patch(safe_context, "synthesis")
    return await _run_synthesis_phase_impl(
        trace, safe_context, raw_text, request_spec, executions, memory_write_result, runtime,
    )


async def _run_synthesis_phase_impl(trace, safe_context, raw_text, request_spec, executions, memory_write_result, runtime):
    """Body of :func:`run_synthesis_phase` — split so the status
    emission above stays at the top without disturbing the long
    docstring that the original function carried.

    Returns a ``(ResponseObject, ResponseEnvelope)`` tuple. The envelope
    rides alongside the legacy ``ResponseObject``; chunk 9 also streams
    envelope-level SSE events (``response_init`` / ``block_init`` /
    ``block_patch`` / ``block_ready`` / ``source_add`` / ``media_add``
    / ``response_snapshot``) through the shared ``_sse_queue`` on the
    context so the frontend can progressively render blocks. The
    legacy ``synthesis`` / ``routing`` / ``decomposition`` phase events
    are emitted unchanged.
    """
    finish = trace.timed("memory_read")
    memory_slots = run_memory_read_path(raw_text, safe_context)
    if memory_slots:
        request_spec.context.setdefault("memory_slots", {}).update(memory_slots)
    finish(slots_assembled=sorted(memory_slots.keys()),
           **{f"{k}_chars": len(v) for k, v in memory_slots.items()})

    # Chunk 17: adaptive document handling. If the turn carried an
    # attached document, pick inline-vs-retrieval and inject a
    # synthetic execution so the adapter-aggregation path below picks
    # up the document's sources alongside any skill sources.
    _apply_attached_document(safe_context, request_spec, executions, raw_text)

    # Cutover: sources + facts are read from execution.adapter_output
    # now, not re-scraped from each skill's dict. Writes land on the
    # spec so _collect_sources + synthesis prompt pick them up without
    # per-skill branches.
    _apply_adapter_outputs_to_spec(request_spec, executions)

    decision = decide_llm(request_spec)
    request_spec.llm_used = decision.needed
    request_spec.llm_reason = decision.reason

    finish = trace.timed("combine")
    envelope_status: str = "complete"
    response = None
    try:
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
    except Exception as exc:
        envelope_status = "failed"
        _emit_synthesis_failure_events(safe_context, trace, exc)
        raise

    envelope = _build_envelope(
        trace=trace,
        request_spec=request_spec,
        executions=executions,
        response=response,
        status=envelope_status,
        safe_context=safe_context,
    )
    _emit_envelope_events(safe_context, envelope)
    return response, envelope


def _emit_envelope_events(safe_context: dict, envelope: ResponseEnvelope) -> None:
    """Stream the rich-response events for a validated envelope.

    Order (per chunk 9's ordering rules):

    1. ``response_init`` announcing the planned block list.
    2. ``block_init`` for every planned block.
    3. ``block_patch`` (summary prose, seq=1) + ``source_add`` /
       ``media_add`` per item, then ``block_ready`` for every
       non-omitted block.
    4. ``response_snapshot`` with the full serialized envelope.

    No-op when no SSE queue is attached (e.g. direct unit tests that
    exercise :func:`run_synthesis_phase` without the streaming wrapper).
    """
    queue = safe_context.get("_sse_queue")
    if queue is None:
        return

    queue.put_nowait(response_events.response_init(
        envelope.request_id, envelope.mode, envelope.blocks,
    ))
    for block in envelope.blocks:
        queue.put_nowait(response_events.block_init(block))

    seq_by_block: dict[str, int] = {}
    for block in envelope.blocks:
        if block.state is BlockState.omitted:
            continue
        if block.type is BlockType.summary and block.content:
            seq_by_block["summary"] = seq_by_block.get("summary", 0) + 1
            queue.put_nowait(response_events.block_patch(
                block.id, seq_by_block["summary"], delta=block.content,
            ))
        elif block.type is BlockType.sources and block.items:
            for source in block.items:
                queue.put_nowait(response_events.source_add(source))
        elif block.type is BlockType.media and block.items:
            for card in block.items:
                queue.put_nowait(response_events.media_add(card))
        elif block.type is BlockType.clarification and block.content:
            # Clarification arrives ready — one patch carries the
            # whole question so replay / reducer don't need a
            # bespoke path.
            seq_by_block[block.id] = seq_by_block.get(block.id, 0) + 1
            queue.put_nowait(response_events.block_patch(
                block.id, seq_by_block[block.id], delta=block.content,
            ))

    # Chunk 15: replay buffered status phrases as sequential
    # ``block_patch`` events. The reducer dedupes by seq, so replays
    # from the snapshot remain idempotent.
    _flush_status_transitions(queue, safe_context, envelope)

    for block in envelope.blocks:
        if block.state is BlockState.ready:
            queue.put_nowait(response_events.block_ready(block.id))

    queue.put_nowait(response_events.response_snapshot(envelope))


def _flush_status_transitions(
    queue,
    safe_context: dict,
    envelope: ResponseEnvelope,
) -> None:
    """Emit ``block_patch`` events for every recorded phase transition.

    The envelope's ``status`` block was pre-allocated by the planner
    (or injected in a follow-up pass). Before emitting we flip its
    state to :attr:`BlockState.omitted` so the final snapshot
    reflects the design-doc contract: the status block is live-only
    and disappears from the finished envelope.
    """
    transitions = safe_context.get(_STATUS_TRANSITIONS_KEY) or []
    status_block = next(
        (b for b in envelope.blocks if b.type is BlockType.status),
        None,
    )
    if status_block is None:
        return

    # Replay transitions as sequential delta patches. Seq starts at 1
    # (0 is "no patch applied yet" in the frontend reducer's guard).
    for idx, phrase in enumerate(transitions, start=1):
        queue.put_nowait(response_events.block_patch(
            status_block.id, idx, delta=phrase,
        ))

    # Finalize: the status block never renders in the snapshot. Flip
    # it to omitted so history replay + validators see the live-only
    # contract the design doc requires.
    status_block.state = BlockState.omitted
    # ``content`` is intentionally cleared — the live stream already
    # carried every phrase via patches.
    status_block.content = None


def _emit_synthesis_failure_events(safe_context: dict, trace, exc: BaseException) -> None:
    """Emit ``block_failed`` for the summary block when synthesis raises.

    The terminal ``response_done`` with ``status=failed`` is emitted by
    :func:`_run_pipeline_task` once the pipeline task unwinds — that
    way both the raise path *and* a non-synthesis crash reach the same
    wire shape.

    Chunk 15: also flip the ``status`` block to the neutral
    :data:`FINISHING_PHRASE` instead of dwelling on the crash — the
    failing block already tells the user what went wrong.
    """
    queue = safe_context.get("_sse_queue")
    if queue is None:
        return
    reason = str(exc) or exc.__class__.__name__
    mark_status_finishing(safe_context)
    queue.put_nowait(response_events.block_failed("summary", reason))


def _build_envelope(
    *,
    trace,
    request_spec,
    executions: list[ExecutionResult],
    response,
    status: str,
    safe_context: dict | None = None,
) -> ResponseEnvelope:
    """Populate the rich-response envelope for this turn.

    The mode is derived from structured planner inputs
    (:func:`lokidoki.orchestrator.response.mode.derive_response_mode`),
    then the planner allocates mode-specific block slots; we then fill
    the summary with ``response.output_text``, the sources block + the
    source surface with the adapter-aggregated sources, and the media
    block with ``request_spec.media``. Validation runs at the end and
    only log-warns on failure — a structural hiccup must not break
    the turn during rollout.
    """
    adapter_outputs = [
        execution.adapter_output for execution in executions
        if execution.adapter_output is not None
    ]
    ctx = safe_context or {}
    artifact_candidate = _first_artifact_candidate(adapter_outputs)
    planner_inputs = _build_planner_inputs(ctx, executions, artifact_candidate)
    derived_mode = derive_response_mode(
        planner_inputs,
        user_override=ctx.get("user_mode_override"),
    )
    clarification_text = _collect_clarification_text(ctx, executions)
    blocks: list[Block] = plan_initial_blocks(
        adapter_outputs,
        mode=derived_mode,
        planner_inputs=planner_inputs,
        clarification_text=clarification_text,
    )
    block_index = {block.id: block for block in blocks}

    source_items: list[dict[str, Any]] = [
        dict(item) for item in (request_spec.adapter_sources or [])
    ]
    media_items: list[dict[str, Any]] = [
        dict(card) for card in (request_spec.media or [])
    ]

    summary_block = block_index.get("summary")
    if summary_block is not None:
        summary_block.content = response.output_text or ""
        summary_block.state = BlockState.ready

    sources_block = block_index.get("sources")
    if sources_block is not None:
        if source_items:
            sources_block.items = source_items
            sources_block.state = BlockState.ready
        else:
            sources_block.items = []
            sources_block.state = BlockState.omitted

    media_block = block_index.get("media")
    if media_block is not None:
        if media_items:
            media_block.items = media_items
            media_block.state = BlockState.ready
        else:
            media_block.items = []
            media_block.state = BlockState.omitted

    artifact_preview = block_index.get("artifact_preview")
    artifact_surface = None
    if derived_mode == "artifact" and artifact_candidate is not None:
        artifact_surface = _build_artifact_surface(artifact_candidate)
        if artifact_preview is not None:
            artifact_preview.items = [_build_artifact_preview_item(artifact_surface)]
            artifact_preview.state = BlockState.ready
    elif artifact_preview is not None:
        artifact_preview.items = []
        artifact_preview.state = BlockState.omitted

    # Chunk 14: populate ``key_facts`` / ``steps`` / ``comparison`` from
    # adapter facts + synthesis output (constrained JSON if present,
    # adapter fallback otherwise). Runs in-place on the planner-
    # allocated blocks; planner-omitted families are untouched.
    populate_text_blocks(
        blocks,
        synthesis_text=getattr(response, "output_text", None) or "",
        adapter_outputs=adapter_outputs,
        comparison_subjects=_comparison_subjects(ctx, executions),
        profile=str(ctx.get("platform_profile") or ""),
    )

    # Chunk 16 (design §20.3): ``spoken_text`` and the visual summary
    # come from the SAME synthesis call — never a second LLM pass. We
    # read whatever the synthesizer produced (``ResponseObject.spoken_text``
    # from the one-call JSON contract; adapter-provided ``data["spoken_text"]``
    # threaded through ``raw_result`` for skills that pre-format a
    # spoken form). ``resolve_spoken_text`` is then the authoritative
    # TTS input for the envelope — the same function the frontend
    # mirror calls so voice and visual stay in sync.
    synth_spoken = getattr(response, "spoken_text", None)
    adapter_spoken = _adapter_spoken_text(executions)
    explicit_spoken = (synth_spoken or adapter_spoken or "").strip() or None

    document_mode = ctx.get("document_mode")
    if document_mode not in ("inline", "retrieval"):
        document_mode = None

    envelope = ResponseEnvelope(
        request_id=getattr(trace, "trace_id", "") or "",
        mode=derived_mode,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        blocks=blocks,
        source_surface=list(source_items),
        artifact_surface=artifact_surface,
        spoken_text=explicit_spoken,
        offline_degraded=is_offline_degraded(executions),
        document_mode=document_mode,  # type: ignore[arg-type]
    )
    # Resolve the authoritative spoken form now that the summary block
    # is populated — when the synthesizer didn't emit ``spoken_text``
    # we fall back to the trimmed summary. The envelope stores the
    # resolved value so history replay + frontend rendering see the
    # same snapshot (§20.4 — one utterance per turn, no retroactive
    # edits).
    resolved = resolve_spoken_text(envelope)
    envelope.spoken_text = resolved or None

    try:
        validate_envelope(envelope)
    except EnvelopeValidationError as exc:
        logger.warning("envelope validation failed: %s", exc)
    return envelope


def _adapter_spoken_text(executions: list[ExecutionResult]) -> str | None:
    """Return the first skill-provided ``spoken_text`` override, if any.

    A handful of skills (e.g. ``movies_fandango``) pre-format a short
    spoken form that's snappier than the visual reply — they surface
    it on ``execution.raw_result["data"]["spoken_text"]``. We prefer
    a skill-provided override over synthesis output when present so
    long reply surfaces (showtime tables, list-heavy answers) don't
    read every line aloud.
    """
    for execution in executions:
        if not execution.success:
            continue
        raw = execution.raw_result if isinstance(execution.raw_result, dict) else {}
        data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        spoken = str(data.get("spoken_text") or raw.get("spoken_text") or "").strip()
        if spoken:
            return spoken
    return None


def _collect_clarification_text(
    safe_context: dict,
    executions: list[ExecutionResult],
) -> str | None:
    """Pull clarification text from structured pipeline signals.

    Chunk 15 wiring. Priority:

    1. ``safe_context[_CLARIFICATION_KEY]`` — any pipeline component
       that emits a ``clarification_question`` event can also stash
       the question text here for the envelope planner to consume.
       This is the DESIGN.md §III.b path.
    2. Adapter ``raw["clarification_prompt"]`` — today only the
       ``people_lookup`` skill surfaces this. Acts as a belt-and-
       suspenders fallback so the clarification UI works even if the
       side-channel event wasn't wired for a given skill.

    Never inspects raw user text — no regex / keyword path.
    """
    explicit = safe_context.get(_CLARIFICATION_KEY)
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    for execution in executions:
        adapter_output: AdapterOutput | None = execution.adapter_output
        if adapter_output is None:
            continue
        raw = adapter_output.raw or {}
        if not isinstance(raw, dict):
            continue
        if not raw.get("needs_clarification"):
            continue
        prompt = str(raw.get("clarification_prompt") or "").strip()
        if prompt:
            return prompt
    return None


def _comparison_subjects(
    safe_context: dict,
    executions: list[ExecutionResult],
) -> tuple[str, str] | None:
    """Best-effort pull of two distinct subjects for a comparison turn.

    Priority order (all structured — never a regex over user text):

    1. ``safe_context["comparison_subjects"]`` — reserved for a future
       decomposer field (see Chunk 14 Deferral). When present, it
       wins.
    2. The first two distinct adapter-source titles from successful
       executions. Comparison turns typically fan out across two
       knowledge lookups, so this is a reasonable proxy for the
       scaffold.

    Returns ``None`` when fewer than two distinct subjects are
    available — the synthesis_blocks helper then marks the
    ``comparison`` block ``omitted`` rather than fabricating labels.
    """
    explicit = safe_context.get("comparison_subjects")
    if isinstance(explicit, (list, tuple)) and len(explicit) >= 2:
        left = str(explicit[0] or "").strip()
        right = str(explicit[1] or "").strip()
        if left and right and left != right:
            return (left, right)

    titles: list[str] = []
    for execution in executions:
        adapter_output: AdapterOutput | None = execution.adapter_output
        if adapter_output is None:
            continue
        for source in adapter_output.sources:
            title = str(source.title or "").strip()
            if title and title not in titles:
                titles.append(title)
                if len(titles) >= 2:
                    return (titles[0], titles[1])
    return None


def _build_planner_inputs(
    safe_context: dict,
    executions: list[ExecutionResult],
    artifact_candidate: dict[str, Any] | None = None,
) -> PlannerInputs:
    """Assemble :class:`PlannerInputs` from already-derived pipeline state.

    Sources (no regex over user text — all signals are structured):

    * :class:`~lokidoki.orchestrator.decomposer.types.RouteDecomposition`
      on ``safe_context["route_decomposition"]`` — carries
      ``capability_need``.
    * ``safe_context["response_shape"]`` — set by
      :func:`lokidoki.orchestrator.pipeline.derivations._derive_response_shape`.
    * ``safe_context["user_mode_override"]`` — reserved; chunk 13 wires
      the compose-bar toggle + ``/deep`` slash, and chunks 18 / 16
      wire the explicit deep opt-in. Until then this stays ``None``.
    * Multi-skill fan-out — counted from ``executions`` success flags.
    """
    decomposition = safe_context.get("route_decomposition")
    capability_need = str(
        getattr(decomposition, "capability_need", "") or ""
    )

    successful = sum(1 for execution in executions if execution.success)
    override = safe_context.get("user_mode_override")
    user_override = override if isinstance(override, str) else None
    deep_opt_in = user_override == "deep"
    profile = safe_context.get("platform_profile")
    wants_artifact = artifact_candidate is not None and should_use_artifact_mode(
        decomposition if decomposition is not None else safe_context,
        user_override,
        profile=profile if isinstance(profile, str) else None,
    )

    return PlannerInputs(
        intent=str(safe_context.get("intent", "") or ""),
        response_shape=str(safe_context.get("response_shape", "") or ""),
        reasoning_complexity=str(
            safe_context.get("reasoning_complexity", "") or ""
        ),
        capability_need=capability_need,
        requires_current_data=bool(
            safe_context.get("requires_current_data", False)
        ),
        multiple_skills_fired=successful > 1,
        has_artifact_output=wants_artifact,
        deep_opt_in=deep_opt_in,
    )


def _first_artifact_candidate(
    adapter_outputs: list[AdapterOutput],
) -> dict[str, Any] | None:
    """Return the first artifact candidate surfaced by any adapter."""
    for output in adapter_outputs:
        for candidate in output.artifact_candidates:
            if isinstance(candidate, dict):
                return dict(candidate)
    return None


def _normalize_artifact_versions(
    candidate: dict[str, Any],
) -> list[dict[str, Any]]:
    versions_raw = candidate.get("versions")
    versions: list[dict[str, Any]] = []
    if isinstance(versions_raw, list):
        for idx, item in enumerate(versions_raw, start=1):
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            if not content:
                continue
            versions.append(
                {
                    "version": int(item.get("version") or idx),
                    "content": content,
                    "created_at": str(item.get("created_at") or ""),
                    "size_bytes": int(
                        item.get("size_bytes") or len(content.encode("utf-8"))
                    ),
                }
            )
    if versions:
        return versions

    content = str(candidate.get("content") or "").strip()
    if not content:
        return []
    return [{
        "version": 1,
        "content": content,
        "created_at": str(candidate.get("created_at") or ""),
        "size_bytes": len(content.encode("utf-8")),
    }]


def _build_artifact_surface(candidate: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize one adapter artifact candidate for the envelope surface."""
    versions = _normalize_artifact_versions(candidate)
    if not versions:
        return None
    selected_version = int(candidate.get("selected_version") or versions[-1]["version"])
    title = str(candidate.get("title") or "Artifact").strip() or "Artifact"
    kind = str(candidate.get("kind") or "html").strip() or "html"
    artifact_id = str(candidate.get("artifact_id") or candidate.get("id") or "").strip()
    if not artifact_id:
        artifact_id = f"artifact-inline-{title.lower().replace(' ', '-')}"
    return {
        "artifact_id": artifact_id,
        "title": title,
        "kind": kind,
        "selected_version": selected_version,
        "versions": versions,
    }


def _build_artifact_preview_item(artifact_surface: dict[str, Any]) -> dict[str, Any]:
    """Build the compact preview payload consumed by the frontend card."""
    versions = artifact_surface.get("versions")
    latest = versions[-1] if isinstance(versions, list) and versions else {}
    content = str(latest.get("content") or "")
    preview = " ".join(content.replace("\n", " ").split())[:160]
    return {
        "artifact_id": artifact_surface.get("artifact_id"),
        "title": artifact_surface.get("title"),
        "kind": artifact_surface.get("kind"),
        "version": latest.get("version"),
        "preview_text": preview,
    }


# Re-export the valid mode set for callers that need to validate a
# raw string (e.g. the chat endpoint accepting ``user_mode_override``
# from the request body in chunk 13). Kept next to the other response
# imports so the pipeline layer has one place to reach for it.
_VALID_RESPONSE_MODES = VALID_MODES


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
