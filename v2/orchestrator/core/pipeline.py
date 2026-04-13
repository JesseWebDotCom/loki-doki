"""Top-level v2 request pipeline."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from v2.orchestrator.core.types import (
    ParsedInput,
    PipelineResult,
    ResponseObject,
    TraceData,
)
from v2.orchestrator.execution.executor import execute_chunk_async
from v2.orchestrator.execution.request_spec import build_request_spec
from v2.orchestrator.fallbacks.llm_fallback import decide_llm, llm_synthesize_async
from v2.orchestrator.memory.extractor import ExtractionContext, extract_candidates
from v2.orchestrator.memory.slots import (
    assemble_recent_context_slot,
    assemble_relevant_episodes_slot,
    assemble_social_context_slot,
    assemble_user_facts_slot,
)
from v2.orchestrator.memory.summarizer import (
    SessionObservation,
    queue_session_close,
)
from v2.orchestrator.memory.store import V2MemoryStore
from v2.orchestrator.memory.writer import WriteRunResult, process_candidates
from v2.orchestrator.observability.tracing import build_trace_summary, start_trace
from v2.orchestrator.pipeline.combiner import combine_request_spec
from v2.orchestrator.pipeline.extractor import extract_chunk_data
from v2.orchestrator.pipeline.fast_lane import check_fast_lane
from v2.orchestrator.pipeline.normalizer import normalize_text
from v2.orchestrator.pipeline.parser import parse_text
from v2.orchestrator.pipeline.splitter import split_requests
from v2.orchestrator.registry.runtime import get_runtime
from v2.orchestrator.resolution.resolver import resolve_chunk_async
from v2.orchestrator.routing.router import route_chunk_async
from v2.orchestrator.signals.interaction_signals import detect_interaction_signals


def run_pipeline(raw_text: str, context: dict[str, Any] | None = None) -> PipelineResult:
    """Synchronous entry point used by tests / the dev runner."""
    return asyncio.run(run_pipeline_async(raw_text, context=context))


async def run_pipeline_async(
    raw_text: str,
    context: dict[str, Any] | None = None,
) -> PipelineResult:
    """Run the v2 prototype pipeline end-to-end."""
    trace = start_trace()
    # Allow callers (e.g. streaming.py) to inject a trace listener via
    # context so they can emit SSE events as each step completes.
    _trace_listener = (context or {}).get("_trace_listener")
    if callable(_trace_listener):
        trace.subscribe(_trace_listener)
    runtime = get_runtime()
    safe_context = context or {}

    # Session lifecycle (M4): create a session when the caller provides
    # a memory store + owner but no existing session_id. The session_id
    # persists in safe_context for the rest of the turn.
    _ensure_session(safe_context)

    finish = trace.timed("normalize")
    normalized = normalize_text(raw_text)
    finish(cleaned_text=normalized.cleaned_text)

    finish = trace.timed("signals")
    signals = detect_interaction_signals(normalized.cleaned_text)
    finish(
        interaction_signal=signals.interaction_signal,
        tone_signal=signals.tone_signal,
        urgency=signals.urgency,
    )

    finish = trace.timed("fast_lane")
    fast_lane = check_fast_lane(normalized.cleaned_text)
    fast_lane_status = "matched" if fast_lane.matched else "bypassed"
    finish(
        matched=fast_lane.matched,
        capability=fast_lane.capability,
        reason=fast_lane.reason,
        status=fast_lane_status,
    )
    if fast_lane.matched:
        return _fast_lane_result(raw_text, normalized, signals, fast_lane, safe_context, trace)

    finish = trace.timed("parse")
    parsed = parse_text(normalized.cleaned_text)
    finish(
        token_count=parsed.token_count,
        sentences=parsed.sentences,
        parser=parsed.parser,
        entity_count=len(parsed.entities),
        noun_chunk_count=len(parsed.noun_chunks),
    )

    finish = trace.timed("split")
    chunks = split_requests(parsed)
    finish(
        count=len(chunks),
        chunks=[chunk.text for chunk in chunks],
        roles=[chunk.role for chunk in chunks],
    )

    finish = trace.timed("extract")
    extractions = extract_chunk_data(chunks, parsed)
    finish(
        references=[item.references for item in extractions],
        predicates=[item.predicates for item in extractions],
        entities=[item.entities for item in extractions],
    )

    finish = trace.timed("memory_write")
    memory_write_result = _run_memory_write_path(parsed, chunks, safe_context)
    finish(
        accepted=len(memory_write_result.accepted),
        rejected=len(memory_write_result.rejected),
        accepted_summary=[
            {
                "subject": d.candidate.subject if d.candidate else "",
                "predicate": d.candidate.predicate if d.candidate else "",
                "value": d.candidate.value if d.candidate else "",
                "tier": int(d.target_tier) if d.target_tier else None,
                "immediate_durable": (
                    d.write_outcome.immediate_durable if d.write_outcome else False
                ),
            }
            for d in memory_write_result.accepted
        ],
        rejected_summary=[
            {
                "subject": (d.candidate.subject if d.candidate else ""),
                "predicate": (d.candidate.predicate if d.candidate else ""),
                "denied_at": (d.rejection.failed_gate if d.rejection else ""),
                "reason": (d.rejection.reason if d.rejection else d.reason),
            }
            for d in memory_write_result.rejected
        ],
    )

    routable = [chunk for chunk in chunks if chunk.role == "primary_request"]
    routable_extractions = [item for item in extractions if any(c.index == item.chunk_index for c in routable)]

    finish = trace.timed("route")
    routed = list(await asyncio.gather(*(_timed_route(chunk, runtime) for chunk in routable)))
    routes = [item["route"] for item in routed]
    finish(
        chunks=[
            {
                "chunk_index": item["route"].chunk_index,
                "text": chunk.text,
                "capability": item["route"].capability,
                "confidence": item["route"].confidence,
                "matched_text": item["route"].matched_text,
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(routable, routed, strict=True)
        ],
    )

    finish = trace.timed("select_implementation")
    selected = list(
        await asyncio.gather(
            *(_timed_select(chunk.index, route.capability, runtime) for chunk, route in zip(routable, routes, strict=True))
        )
    )
    implementations = [item["implementation"] for item in selected]
    finish(
        chunks=[
            {
                "chunk_index": item["implementation"].chunk_index,
                "text": chunk.text,
                "capability": item["implementation"].capability,
                "handler_name": item["implementation"].handler_name,
                "implementation_id": item["implementation"].implementation_id,
                "priority": item["implementation"].priority,
                "candidate_count": item["implementation"].candidate_count,
                "candidates": item["candidates"],
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(routable, selected, strict=True)
        ],
    )

    # Bridge v2 session state into context["recent_entities"] so the
    # existing pronoun resolver can consult last-seen entities (M4).
    _bridge_session_state_to_recent_entities(safe_context)

    finish = trace.timed("resolve")
    resolved = list(
        await asyncio.gather(
            *(
                _timed_resolve(chunk, extraction, route, safe_context)
                for chunk, extraction, route in zip(routable, routable_extractions, routes, strict=True)
            )
        )
    )
    resolutions = [item["resolution"] for item in resolved]
    finish(
        chunks=[
            {
                "chunk_index": item["resolution"].chunk_index,
                "text": chunk.text,
                "resolved_target": item["resolution"].resolved_target,
                "source": item["resolution"].source,
                "confidence": item["resolution"].confidence,
                "context_value": item["resolution"].context_value,
                "candidate_values": item["resolution"].candidate_values,
                "unresolved": item["resolution"].unresolved,
                "params": item["resolution"].params,
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(routable, resolved, strict=True)
        ],
    )

    finish = trace.timed("execute")
    # Look up per-capability budget from registry for timeout enforcement.
    budgets = [
        (runtime.capabilities.get(route.capability) or {}).get("max_chunk_budget_ms")
        for route in routes
    ]
    executed = list(
        await asyncio.gather(
            *(
                _timed_execute(chunk, route, implementation, resolution, budget_ms=budget)
                for chunk, route, implementation, resolution, budget in zip(
                    routable,
                    routes,
                    implementations,
                    resolutions,
                    budgets,
                    strict=True,
                )
            )
        )
    )
    executions = [item["execution"] for item in executed]
    finish(
        chunks=[
            {
                "chunk_index": item["execution"].chunk_index,
                "text": chunk.text,
                "capability": item["execution"].capability,
                "output_text": item["execution"].output_text,
                "success": item["execution"].success,
                "error": item["execution"].error,
                "attempts": item["execution"].attempts,
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(routable, executed, strict=True)
        ],
    )

    finish = trace.timed("request_spec")
    request_spec = build_request_spec(
        raw_text=raw_text,
        chunks=chunks,
        routes=routes,
        implementations=implementations,
        resolutions=resolutions,
        executions=executions,
        context=safe_context,
        trace_id=trace.trace_id,
    )
    finish(chunk_count=len(request_spec.chunks), trace_id=request_spec.trace_id)

    # Session state update (M4): record last-seen entities from
    # resolved chunks so the pronoun resolver can use them next turn.
    _run_session_state_update(safe_context, resolutions)

    # Auto-raise need_session_context if any resolution has unresolved
    # referents (M4). This ensures the read path assembles the
    # recent_context slot even if the decomposer didn't set the flag.
    _auto_raise_need_session_context(safe_context, resolutions)

    finish = trace.timed("memory_read")
    memory_slots = _run_memory_read_path(raw_text, safe_context)
    if memory_slots:
        request_spec.context.setdefault("memory_slots", {}).update(memory_slots)
    finish(
        slots_assembled=sorted(memory_slots.keys()),
        user_facts_chars=len(memory_slots.get("user_facts", "")),
        social_context_chars=len(memory_slots.get("social_context", "")),
        recent_context_chars=len(memory_slots.get("recent_context", "")),
        relevant_episodes_chars=len(memory_slots.get("relevant_episodes", "")),
    )

    decision = decide_llm(request_spec)
    request_spec.llm_used = decision.needed
    request_spec.llm_reason = decision.reason

    finish = trace.timed("combine")
    if decision.needed:
        response = await llm_synthesize_async(request_spec)
        finish(mode="llm", reason=decision.reason, output_text=response.output_text)
    else:
        response = combine_request_spec(request_spec)
        finish(mode="deterministic", output_text=response.output_text)

    # Session close hook (M4): if the caller flagged this as the closing
    # turn, queue the session-close summarization job. The work runs
    # out-of-band so the user-visible latency is unaffected.
    _maybe_queue_session_close(safe_context, memory_write_result)

    return PipelineResult(
        normalized=normalized,
        signals=signals,
        fast_lane=fast_lane,
        parsed=_strip_doc(parsed),
        chunks=chunks,
        extractions=extractions,
        routes=routes,
        implementations=implementations,
        resolutions=resolutions,
        executions=executions,
        request_spec=request_spec,
        response=response,
        trace=trace,
        trace_summary=build_trace_summary(trace),
    )


def _bridge_session_state_to_recent_entities(safe_context: dict[str, Any]) -> None:
    """Populate context["recent_entities"] from the v2 session's last-seen map.

    This bridges M4's Tier 2 session state into the format that
    ``ConversationMemoryAdapter`` reads, so the existing pronoun resolver
    can bind "it"/"that" to the most recently mentioned entity without
    changes to its own code.
    """
    store = safe_context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return
    state = store.get_session_state(int(session_id))
    last_seen = state.get("last_seen")
    if not isinstance(last_seen, dict) or not last_seen:
        return
    entities: list[dict[str, str]] = safe_context.get("recent_entities") or []
    # Convert last_seen entries to the format ConversationMemoryAdapter expects:
    # [{"name": "...", "type": "..."}]
    seen_names: set[str] = {e.get("name", "").lower() for e in entities if isinstance(e, dict)}
    for key, entry in last_seen.items():
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        if not name or name.lower() in seen_names:
            continue
        # key is "last_<type>", extract the type
        entity_type = key.removeprefix("last_").strip("_")
        entities.append({"name": name, "type": entity_type})
        seen_names.add(name.lower())
    safe_context["recent_entities"] = entities


def _auto_raise_need_session_context(
    safe_context: dict[str, Any],
    resolutions: list,
) -> None:
    """Set need_session_context=True if any resolution has unresolved referents.

    Per MEMORY_DESIGN.md §4: "The pronoun resolver may also raise
    need_session_context even if the decomposer didn't, when it detects
    an unresolved reference."
    """
    for resolution in resolutions:
        unresolved = getattr(resolution, "unresolved", None) or []
        if any(str(u).startswith("referent:") for u in unresolved):
            safe_context["need_session_context"] = True
            return


def _ensure_session(safe_context: dict[str, Any]) -> None:
    """Create a session row when memory is enabled but no session exists yet.

    The session_id is stored on ``safe_context["session_id"]`` and persists
    for the lifetime of the pipeline call. Subsequent turns in the same
    session should pass the same ``session_id`` in their context.
    """
    if safe_context.get("session_id") is not None:
        return
    store = safe_context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return
    enabled = bool(safe_context.get("memory_writes_enabled")) or safe_context.get("memory_store") is not None
    if not enabled:
        return
    session_id = store.create_session(owner_user_id)
    safe_context["session_id"] = session_id


def _run_session_state_update(
    safe_context: dict[str, Any],
    resolutions: list,
) -> None:
    """Update the session's last-seen map from resolved entities (M4).

    After resolution, each chunk may have a ``resolved_target`` with an
    entity type. We record the most recent one per type so the pronoun
    resolver can use it on the next turn.
    """
    store = safe_context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return
    for resolution in resolutions:
        resolved = getattr(resolution, "resolved_target", None)
        params = getattr(resolution, "params", None) or {}
        if not resolved:
            continue
        # Infer entity type from the resolution's params or source
        entity_type = str(params.get("entity_type", ""))
        if not entity_type:
            source = getattr(resolution, "source", "") or ""
            if "people" in source:
                entity_type = "person"
            elif "movie" in source or "media" in source:
                entity_type = "movie"
            elif "device" in source:
                entity_type = "device"
            else:
                entity_type = "entity"
        store.update_last_seen(
            int(session_id),
            entity_type=entity_type,
            entity_name=str(resolved),
        )


def _maybe_queue_session_close(
    safe_context: dict[str, Any],
    memory_write_result: WriteRunResult,
) -> None:
    """Queue session-close summarization when the caller flags session_closing.

    The actual summarization runs out-of-band (tests call
    ``run_pending_summaries()`` synchronously to flush).
    """
    if not safe_context.get("session_closing"):
        return
    store = safe_context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return

    # Build observations from this turn's accepted memory writes.
    # In a real multi-turn session, the caller accumulates observations
    # across turns in safe_context["session_observations"].
    observations: list[SessionObservation] = list(
        safe_context.get("session_observations") or []
    )
    for decision in memory_write_result.accepted:
        if decision.candidate:
            observations.append(
                SessionObservation(
                    subject=decision.candidate.subject,
                    predicate=decision.candidate.predicate,
                    value=decision.candidate.value,
                    source_text=decision.candidate.source_text or "",
                )
            )

    queue_session_close(
        store=store,
        session_id=int(session_id),
        owner_user_id=owner_user_id,
        observations=observations,
        explicit_topic_scope=safe_context.get("topic_scope"),
    )


def _strip_doc(parsed: ParsedInput) -> ParsedInput:
    """Drop the spaCy ``Doc`` reference so the result can be JSON-serialised."""
    parsed.doc = None
    return parsed


def _run_memory_read_path(
    raw_text: str,
    safe_context: dict[str, Any],
) -> dict[str, str]:
    """Lazy memory read step (M2 + M3 + M4).

    Each tier slot is gated by its own ``need_*`` flag so callers only
    pay the latency cost for the slots they actually want. The flags
    are independent: a turn can ask for ``need_preference`` (Tier 4)
    without ``need_social`` (Tier 5), or vice versa, or both.

    Returns the dict of slot strings that should be merged into
    ``request_spec.context["memory_slots"]``. Empty dict means no
    slot was assembled.
    """
    store = safe_context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return {}
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    query = str(safe_context.get("memory_query") or raw_text)
    out: dict[str, str] = {}

    # Tier 4 (M2)
    if safe_context.get("need_preference"):
        rendered, _hits = assemble_user_facts_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
        )
        out["user_facts"] = rendered

    # Tier 5 (M3)
    if safe_context.get("need_social"):
        rendered, _hits = assemble_social_context_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
        )
        out["social_context"] = rendered

    # Tier 2 — session context (M4)
    session_id = safe_context.get("session_id")
    if safe_context.get("need_session_context") and session_id is not None:
        rendered, _ctx = assemble_recent_context_slot(
            store=store,
            session_id=int(session_id),
        )
        out["recent_context"] = rendered

    # Tier 3 — episodic recall (M4)
    if safe_context.get("need_episode"):
        topic_scope = safe_context.get("topic_scope")
        rendered, _hits = assemble_relevant_episodes_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
            topic_scope=topic_scope,
        )
        out["relevant_episodes"] = rendered

    return out


def _run_memory_write_path(
    parsed: ParsedInput,
    chunks: list,  # type: ignore[type-arg]
    safe_context: dict[str, Any],
) -> WriteRunResult:
    """Run the M1 write path on the current turn.

    Memory writes are **opt-in**: the dev-tools v2 prototype runner enables
    them by passing ``context["memory_writes_enabled"] = True`` (or by
    passing ``context["memory_store"]`` directly with a custom store, used
    by tests). When neither is present the path is a no-op so the
    existing v2 regression suite isn't affected by storage side-effects.

    The extractor walks the spaCy parse tree (which is already in
    ``parsed.doc``) and proposes candidates per primary chunk. The writer
    then runs the gate chain, classifier, and store dispatch.
    """
    enabled = bool(safe_context.get("memory_writes_enabled"))
    custom_store = safe_context.get("memory_store")
    if not enabled and custom_store is None:
        return WriteRunResult()
    parse_doc = getattr(parsed, "doc", None)
    if parse_doc is None:
        return WriteRunResult()
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    decomposed_intent = safe_context.get("decomposed_intent")
    resolved_people = safe_context.get("resolved_people") or []
    known_entities = safe_context.get("known_entities") or []
    aggregate = WriteRunResult()
    for chunk in chunks:
        if chunk.role != "primary_request":
            continue
        ext_context = ExtractionContext(
            owner_user_id=owner_user_id,
            chunk_index=chunk.index,
            source_text=chunk.text,
        )
        candidates = extract_candidates(parse_doc, context=ext_context)
        if not candidates:
            continue
        run = process_candidates(
            candidates,
            parse_doc=parse_doc,
            resolved_people=resolved_people,
            known_entities=known_entities,
            decomposed_intent=decomposed_intent,
            store=custom_store,
        )
        aggregate.accepted.extend(run.accepted)
        aggregate.rejected.extend(run.rejected)
    return aggregate


def _fast_lane_result(
    raw_text: str,
    normalized,
    signals,
    fast_lane,
    context: dict[str, Any],
    trace: TraceData,
) -> PipelineResult:
    response = ResponseObject(output_text=fast_lane.response_text or "")
    spec = build_request_spec(
        raw_text=raw_text,
        chunks=[],
        routes=[],
        implementations=[],
        resolutions=[],
        executions=[],
        context=context,
        trace_id=trace.trace_id,
    )
    return PipelineResult(
        normalized=normalized,
        signals=signals,
        fast_lane=fast_lane,
        parsed=ParsedInput(token_count=0, tokens=[], sentences=[], parser="bypassed"),
        chunks=[],
        extractions=[],
        routes=[],
        implementations=[],
        resolutions=[],
        executions=[],
        request_spec=spec,
        response=response,
        trace=trace,
        trace_summary=build_trace_summary(trace),
    )


async def _timed_route(chunk, runtime):
    started = time.perf_counter()
    route = await route_chunk_async(chunk, runtime)
    return {"route": route, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}


async def _timed_select(chunk_index, capability, runtime):
    started = time.perf_counter()
    implementation = runtime.select_handler(chunk_index, capability)
    candidates = sorted(
        [
            {
                "id": str(item.get("id") or ""),
                "handler_name": str(item.get("handler_name") or ""),
                "priority": int(item.get("priority", 999)),
                "enabled": bool(item.get("enabled", True)),
            }
            for item in (runtime.capabilities.get(capability) or {}).get("implementations", [])
            if item.get("enabled", True)
        ],
        key=lambda item: item["priority"],
    )
    return {
        "implementation": implementation,
        "candidates": candidates,
        "timing_ms": round((time.perf_counter() - started) * 1000, 3),
    }


async def _timed_resolve(chunk, extraction, route, context):
    started = time.perf_counter()
    resolution = await resolve_chunk_async(chunk, extraction, route, context)
    return {"resolution": resolution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}


async def _timed_execute(chunk, route, implementation, resolution, *, budget_ms=None):
    started = time.perf_counter()
    execution = await execute_chunk_async(chunk, route, implementation, resolution, budget_ms=budget_ms)
    return {"execution": execution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}
