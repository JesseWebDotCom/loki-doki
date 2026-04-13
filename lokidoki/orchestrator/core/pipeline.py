"""Top-level request pipeline."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from lokidoki.orchestrator.core.pipeline_hooks import (
    ensure_session,
    maybe_queue_session_close,
)
from lokidoki.orchestrator.core.pipeline_phases import (
    build_and_annotate_spec,
    run_derivations_phase,
    run_execute_phase,
    run_initial_phase,
    run_pre_parse_phase,
    run_resolve_phase,
    run_routing_phase,
    run_synthesis_phase,
)
from lokidoki.orchestrator.core.types import (
    ParsedInput,
    PipelineResult,
    ResponseObject,
)
from lokidoki.orchestrator.execution.request_spec import build_request_spec
from lokidoki.orchestrator.observability.tracing import build_trace_summary, start_trace
from lokidoki.orchestrator.registry.runtime import get_runtime

logger = logging.getLogger(__name__)


def run_pipeline(raw_text: str, context: dict[str, Any] | None = None) -> PipelineResult:
    """Synchronous entry point used by tests / the dev runner."""
    return asyncio.run(run_pipeline_async(raw_text, context=context))


async def run_pipeline_async(
    raw_text: str, context: dict[str, Any] | None = None,
) -> PipelineResult:
    """Run the pipeline end-to-end."""
    trace, runtime, ctx = _init_trace(context)
    ensure_session(ctx)
    normalized, signals, fast_lane = run_pre_parse_phase(trace, ctx, raw_text)
    if fast_lane.matched:
        return _fast_lane_result(raw_text, normalized, signals, fast_lane, ctx, trace)
    parsed, chunks, extractions, mw = run_initial_phase(trace, ctx, raw_text, normalized)
    routable, routable_ext = _filter_routable(chunks, extractions)
    routes, impls = await run_routing_phase(trace, ctx, routable, runtime)
    dp = run_derivations_phase(trace, ctx, parsed, chunks, extractions, routes)
    resolutions = await run_resolve_phase(trace, ctx, routable, routable_ext, routes, dp)
    executions = await run_execute_phase(trace, ctx, runtime, routable, routes, impls, resolutions)
    spec = build_and_annotate_spec(
        trace, ctx, raw_text, chunks, routes, impls, resolutions, executions, signals)
    response = await run_synthesis_phase(trace, ctx, raw_text, spec, mw)
    maybe_queue_session_close(ctx, mw)
    return PipelineResult(
        normalized=normalized, signals=signals, fast_lane=fast_lane,
        parsed=_strip_doc(parsed), chunks=chunks, extractions=extractions,
        routes=routes, implementations=impls, resolutions=resolutions,
        executions=executions, request_spec=spec, response=response,
        trace=trace, trace_summary=build_trace_summary(trace))


def _init_trace(context):
    """Set up trace, runtime, and safe context."""
    trace = start_trace()
    listener = (context or {}).get("_trace_listener")
    if callable(listener):
        trace.subscribe(listener)
    return trace, get_runtime(), context or {}


def _filter_routable(chunks, extractions):
    """Split chunks/extractions into the routable subset."""
    routable = [c for c in chunks if c.role == "primary_request"]
    routable_extractions = [
        item for item in extractions
        if any(c.index == item.chunk_index for c in routable)
    ]
    return routable, routable_extractions


def _fast_lane_result(raw_text, normalized, signals, fast_lane, context, trace):
    spec = build_request_spec(raw_text=raw_text, chunks=[], routes=[],
        implementations=[], resolutions=[], executions=[],
        context=context, trace_id=trace.trace_id)
    empty: list = []
    return PipelineResult(
        normalized=normalized, signals=signals, fast_lane=fast_lane,
        parsed=ParsedInput(token_count=0, tokens=[], sentences=[], parser="bypassed"),
        chunks=empty, extractions=empty, routes=empty, implementations=empty,
        resolutions=empty, executions=empty, request_spec=spec,
        response=ResponseObject(output_text=fast_lane.response_text or ""),
        trace=trace, trace_summary=build_trace_summary(trace))


def _strip_doc(parsed: ParsedInput) -> ParsedInput:
    parsed.doc = None
    return parsed
