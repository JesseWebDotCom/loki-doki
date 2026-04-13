"""Top-level request pipeline."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

from lokidoki.orchestrator.core.pipeline_hooks import (
    auto_raise_need_session_context,
    bridge_session_state_to_recent_entities,
    ensure_session,
    maybe_queue_session_close,
    record_behavior_event,
    record_sentiment,
    run_session_state_update,
)
from lokidoki.orchestrator.core.pipeline_memory import (
    run_memory_read_path,
    run_memory_write_path,
)
from lokidoki.orchestrator.core.types import (
    ParsedInput,
    PipelineResult,
    ResponseObject,
    TraceData,
)
from lokidoki.orchestrator.execution.executor import execute_chunk_async
from lokidoki.orchestrator.execution.request_spec import build_request_spec
from lokidoki.orchestrator.fallbacks.llm_fallback import decide_llm, llm_synthesize_async
from lokidoki.orchestrator.observability.tracing import build_trace_summary, start_trace
from lokidoki.orchestrator.pipeline.combiner import combine_request_spec
from lokidoki.orchestrator.pipeline.derivations import derive_need_flags, extract_structured_params
from lokidoki.orchestrator.pipeline.extractor import extract_chunk_data
from lokidoki.orchestrator.pipeline.fast_lane import check_fast_lane
from lokidoki.orchestrator.pipeline.normalizer import normalize_text
from lokidoki.orchestrator.pipeline.parser import parse_text
from lokidoki.orchestrator.pipeline.splitter import split_requests
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.resolution.resolver import resolve_chunk_async
from lokidoki.orchestrator.routing.router import route_chunk_async
from lokidoki.orchestrator.signals.interaction_signals import detect_interaction_signals


def run_pipeline(raw_text: str, context: dict[str, Any] | None = None) -> PipelineResult:
    """Synchronous entry point used by tests / the dev runner."""
    return asyncio.run(run_pipeline_async(raw_text, context=context))


async def run_pipeline_async(
    raw_text: str,
    context: dict[str, Any] | None = None,
) -> PipelineResult:
    """Run the pipeline end-to-end."""
    trace = start_trace()
    _trace_listener = (context or {}).get("_trace_listener")
    if callable(_trace_listener):
        trace.subscribe(_trace_listener)
    runtime = get_runtime()
    safe_context = context or {}
    logger.debug(f"[Pipeline] Starting request: {raw_text[:50]}... (trace={trace.trace_id})")

    ensure_session(safe_context)

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
    finish(matched=fast_lane.matched, capability=fast_lane.capability,
           reason=fast_lane.reason, status=fast_lane_status)
    if fast_lane.matched:
        return _fast_lane_result(raw_text, normalized, signals, fast_lane, safe_context, trace)

    finish = trace.timed("parse")
    parsed = parse_text(normalized.cleaned_text)
    logger.debug(f"[Pipeline] Parsed tokens: {parsed.token_count}")
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

    finish = trace.timed("memory_write")
    memory_write_result = run_memory_write_path(parsed, chunks, safe_context)
    finish(accepted=len(memory_write_result.accepted),
           rejected=len(memory_write_result.rejected))

    routable = [c for c in chunks if c.role == "primary_request"]
    routable_extractions = [
        item for item in extractions
        if any(c.index == item.chunk_index for c in routable)
    ]

    finish = trace.timed("route")
    routed = list(await asyncio.gather(*(_timed_route(c, runtime) for c in routable)))
    routes = [item["route"] for item in routed]
    for r in routes:
        logger.debug(f"[Pipeline] Routed chunk {r.chunk_index} to {r.capability} (conf={r.confidence})")
    finish(chunks=[
        {"chunk_index": item["route"].chunk_index, "text": c.text,
         "capability": item["route"].capability,
         "confidence": item["route"].confidence,
         "matched_text": item["route"].matched_text,
         "timing_ms": item["timing_ms"]}
        for c, item in zip(routable, routed, strict=True)
    ])

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

    finish = trace.timed("derive_flags")
    derived = derive_need_flags(parsed, chunks, extractions, routes, safe_context)
    for key, value in derived.items():
        safe_context.setdefault(key, value)
    derived_params = extract_structured_params(chunks, extractions, routes)
    finish(flags=sorted(derived.keys()), params_chunks=sorted(derived_params.keys()))

    bridge_session_state_to_recent_entities(safe_context)

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

    finish = trace.timed("execute")
    budgets = [
        (runtime.capabilities.get(r.capability) or {}).get("max_chunk_budget_ms")
        for r in routes
    ]
    executed = list(await asyncio.gather(*(
        _timed_execute(c, r, impl, res, budget_ms=b)
        for c, r, impl, res, b in zip(
            routable, routes, implementations, resolutions, budgets, strict=True)
    )))
    executions = [item["execution"] for item in executed]
    for ex in executions:
        logger.debug(f"[Pipeline] Executed {ex.capability} (success={ex.success})")
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

    finish = trace.timed("request_spec")
    request_spec = build_request_spec(
        raw_text=raw_text, chunks=chunks, routes=routes,
        implementations=implementations, resolutions=resolutions,
        executions=executions, context=safe_context, trace_id=trace.trace_id,
    )
    finish(chunk_count=len(request_spec.chunks), trace_id=request_spec.trace_id)

    run_session_state_update(safe_context, resolutions)
    auto_raise_need_session_context(safe_context, resolutions)
    record_behavior_event(safe_context, executions, routes)
    record_sentiment(safe_context, signals)

    finish = trace.timed("memory_read")
    memory_slots = run_memory_read_path(raw_text, safe_context)
    if memory_slots:
        request_spec.context.setdefault("memory_slots", {}).update(memory_slots)
    finish(
        slots_assembled=sorted(memory_slots.keys()),
        user_facts_chars=len(memory_slots.get("user_facts", "")),
        social_context_chars=len(memory_slots.get("social_context", "")),
        recent_context_chars=len(memory_slots.get("recent_context", "")),
        relevant_episodes_chars=len(memory_slots.get("relevant_episodes", "")),
        user_style_chars=len(memory_slots.get("user_style", "")),
        recent_mood_chars=len(memory_slots.get("recent_mood", "")),
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

    logger.debug(f"[Pipeline] Completed: {response.output_text[:50]}...")
    maybe_queue_session_close(safe_context, memory_write_result)

    return PipelineResult(
        normalized=normalized, signals=signals, fast_lane=fast_lane,
        parsed=_strip_doc(parsed), chunks=chunks, extractions=extractions,
        routes=routes, implementations=implementations,
        resolutions=resolutions, executions=executions,
        request_spec=request_spec, response=response,
        trace=trace, trace_summary=build_trace_summary(trace),
    )


def _fast_lane_result(raw_text, normalized, signals, fast_lane, context, trace):
    response = ResponseObject(output_text=fast_lane.response_text or "")
    spec = build_request_spec(
        raw_text=raw_text, chunks=[], routes=[], implementations=[],
        resolutions=[], executions=[], context=context, trace_id=trace.trace_id,
    )
    return PipelineResult(
        normalized=normalized, signals=signals, fast_lane=fast_lane,
        parsed=ParsedInput(token_count=0, tokens=[], sentences=[], parser="bypassed"),
        chunks=[], extractions=[], routes=[], implementations=[],
        resolutions=[], executions=[], request_spec=spec, response=response,
        trace=trace, trace_summary=build_trace_summary(trace),
    )


def _strip_doc(parsed: ParsedInput) -> ParsedInput:
    parsed.doc = None
    return parsed


async def _timed_route(chunk, runtime):
    started = time.perf_counter()
    route = await route_chunk_async(chunk, runtime)
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


async def _timed_execute(chunk, route, implementation, resolution, *, budget_ms=None):
    started = time.perf_counter()
    execution = await execute_chunk_async(chunk, route, implementation, resolution, budget_ms=budget_ms)
    return {"execution": execution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}
