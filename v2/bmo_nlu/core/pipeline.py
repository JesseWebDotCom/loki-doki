"""Top-level deterministic v2 request pipeline."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from v2.bmo_nlu.core.types import (
    ParsedInput,
    PipelineResult,
    ResponseObject,
    TraceData,
    TraceSummary,
)
from v2.bmo_nlu.execution.executor import execute_chunk, execute_chunk_async
from v2.bmo_nlu.execution.request_spec import build_request_spec
from v2.bmo_nlu.pipeline.combiner import combine_outputs
from v2.bmo_nlu.pipeline.extractor import extract_chunk_data
from v2.bmo_nlu.pipeline.fast_lane import check_fast_lane
from v2.bmo_nlu.pipeline.normalizer import normalize_text
from v2.bmo_nlu.pipeline.parser import parse_text
from v2.bmo_nlu.pipeline.splitter import split_requests
from v2.bmo_nlu.registry.runtime import get_runtime
from v2.bmo_nlu.resolution.resolver import resolve_chunk_async
from v2.bmo_nlu.routing.router import route_chunk_async
from v2.bmo_nlu.signals.interaction_signals import detect_interaction_signals


def run_pipeline(raw_text: str, context: dict[str, Any] | None = None) -> PipelineResult:
    """Run the current Phase 1 v2 prototype pipeline."""
    return asyncio.run(run_pipeline_async(raw_text, context=context))


async def run_pipeline_async(raw_text: str, context: dict[str, Any] | None = None) -> PipelineResult:
    """Run the current Phase 1 v2 prototype pipeline asynchronously."""
    trace = TraceData()
    runtime = get_runtime()
    safe_context = context or {}

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
    finish(matched=fast_lane.matched, capability=fast_lane.capability, reason=fast_lane.reason, status=fast_lane_status)
    if fast_lane.matched:
        response = ResponseObject(output_text=fast_lane.response_text or "")
        return PipelineResult(
            normalized=normalized,
            signals=signals,
            fast_lane=fast_lane,
            parsed=ParsedInput(token_count=0, tokens=[], sentences=[]),
            chunks=[],
            extractions=[],
            routes=[],
            implementations=[],
            resolutions=[],
            executions=[],
            request_spec=build_request_spec(
                raw_text=raw_text,
                chunks=[],
                routes=[],
                implementations=[],
                resolutions=[],
                executions=[],
                context=safe_context,
            ),
            response=response,
            trace=trace,
            trace_summary=_build_trace_summary(trace),
        )

    finish = trace.timed("parse")
    parsed = parse_text(normalized.cleaned_text)
    finish(token_count=parsed.token_count, sentences=parsed.sentences)

    finish = trace.timed("split")
    chunks = split_requests(normalized.cleaned_text)
    finish(count=len(chunks), chunks=[chunk.text for chunk in chunks])

    finish = trace.timed("extract")
    extractions = extract_chunk_data(chunks)
    finish(
        references=[item.references for item in extractions],
        predicates=[item.predicates for item in extractions],
    )

    finish = trace.timed("route")
    routed = list(await asyncio.gather(*(_timed_route(chunk, runtime) for chunk in chunks)))
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
            for chunk, item in zip(chunks, routed, strict=True)
        ],
    )

    finish = trace.timed("select_implementation")
    selected = list(
        await asyncio.gather(*(_timed_select(chunk.index, route.capability, runtime) for chunk, route in zip(chunks, routes, strict=True)))
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
            for chunk, item in zip(chunks, selected, strict=True)
        ],
    )

    finish = trace.timed("resolve")
    resolved = list(
        await asyncio.gather(
            *(
                _timed_resolve(chunk, extraction, route, safe_context)
                for chunk, extraction, route in zip(chunks, extractions, routes, strict=True)
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
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(chunks, resolved, strict=True)
        ],
    )

    finish = trace.timed("execute")
    executed = list(
        await asyncio.gather(
            *(
                _timed_execute(chunk, route, implementation, resolution)
                for chunk, route, implementation, resolution in zip(
                    chunks,
                    routes,
                    implementations,
                    resolutions,
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
                "timing_ms": item["timing_ms"],
            }
            for chunk, item in zip(chunks, executed, strict=True)
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
    )
    finish(chunk_count=len(request_spec.chunks), trace_id=request_spec.trace_id)

    finish = trace.timed("combine")
    response = combine_outputs(executions)
    finish(output_text=response.output_text)

    return PipelineResult(
        normalized=normalized,
        signals=signals,
        fast_lane=fast_lane,
        parsed=parsed,
        chunks=chunks,
        extractions=extractions,
        routes=routes,
        implementations=implementations,
        resolutions=resolutions,
        executions=executions,
        request_spec=request_spec,
        response=response,
        trace=trace,
        trace_summary=_build_trace_summary(trace),
    )


def _build_trace_summary(trace: TraceData) -> TraceSummary:
    total = sum(step.timing_ms for step in trace.steps)
    if not trace.steps:
        return TraceSummary(total_timing_ms=0.0, step_count=0)
    slowest = max(trace.steps, key=lambda step: step.timing_ms)
    return TraceSummary(
        total_timing_ms=round(total, 3),
        slowest_step_name=slowest.name,
        slowest_step_timing_ms=slowest.timing_ms,
        step_count=len(trace.steps),
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


async def _timed_execute(chunk, route, implementation, resolution):
    started = time.perf_counter()
    execution = await execute_chunk_async(chunk, route, implementation, resolution)
    return {"execution": execution, "timing_ms": round((time.perf_counter() - started) * 1000, 3)}
