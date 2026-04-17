"""Top-level request pipeline."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from lokidoki.orchestrator.core.pipeline_hooks import (
    bridge_session_state_to_recent_entities,
    ensure_session,
    maybe_queue_session_close,
)
from lokidoki.orchestrator.core.pipeline_phases import (
    build_and_annotate_spec,
    run_derivations_phase,
    run_execute_phase,
    run_initial_phase,
    run_media_augmentation_phase,
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
    bridge_session_state_to_recent_entities(ctx)
    normalized, signals, fast_lane = run_pre_parse_phase(trace, ctx, raw_text)
    if fast_lane.matched:
        return _fast_lane_result(raw_text, normalized, signals, fast_lane, ctx, trace)
    parsed, chunks, extractions, constraints, mw = run_initial_phase(trace, ctx, raw_text, normalized)
    ctx["constraints"] = constraints
    routable, routable_ext = _filter_routable(chunks, extractions)
    routable = _resolve_antecedents(routable, ctx)
    routes, impls = await run_routing_phase(trace, ctx, routable, runtime, routable_ext)
    dp = run_derivations_phase(trace, ctx, parsed, chunks, extractions, routes)
    resolutions = await run_resolve_phase(trace, ctx, routable, routable_ext, routes, dp)
    executions = await run_execute_phase(trace, ctx, runtime, routable, routes, impls, resolutions)
    spec = build_and_annotate_spec(
        trace, ctx, raw_text, chunks, routes, impls, resolutions, executions, signals,
        extractions=extractions)
    # Media augmentation runs BEFORE synthesis so the combine prompt
    # can include a media_hint slot — otherwise the LLM writes things
    # like "I couldn't find the trailer" while a trailer card is
    # actually being rendered above its reply. For turns whose router
    # capability is not media-eligible, augmentation is a near-instant
    # no-op (see augmentor's fast-path), so non-media turns don't pay
    # for this ordering.
    spec.media = await run_media_augmentation_phase(
        trace, routable, routes, executions, raw_text=raw_text,
    )
    response = await run_synthesis_phase(trace, ctx, raw_text, spec, executions, mw, runtime)
    # Post-synthesis filter: drop media cards when the model still
    # punted with a clarification / deferral despite the media_hint.
    # Showing a random video next to "I'm not sure" is worse than
    # showing no media at all.
    if spec.media and _is_deferral_response(response.output_text):
        logger.info("[Media] suppressing %d card(s) — response looks like a deferral", len(spec.media))
        spec.media = []
    maybe_queue_session_close(ctx, mw)
    return PipelineResult(
        normalized=normalized, signals=signals, fast_lane=fast_lane,
        parsed=_strip_doc(parsed), chunks=chunks, extractions=extractions,
        routes=routes, implementations=impls, resolutions=resolutions,
        executions=executions, request_spec=spec, response=response,
        trace=trace, trace_summary=build_trace_summary(trace))


def _init_trace(context):
    """Set up trace, runtime, and safe context."""
    from datetime import datetime
    
    trace = start_trace()
    listener = (context or {}).get("_trace_listener")
    if callable(listener):
        trace.subscribe(listener)
        
    now = datetime.now()
    safe_context = context or {}
    # Inject compact format for prompt budget and ISO for machine parsing
    safe_context.setdefault("current_time", now.strftime("%Y-%m-%d %H:%M"))
    safe_context.setdefault("current_iso_time", now.isoformat())
    
    return trace, get_runtime(), safe_context


def _resolve_antecedents(routable, ctx):
    """Replace subject pronouns with the most recent topic before routing."""
    from lokidoki.orchestrator.pipeline.antecedent import resolve_antecedents
    return resolve_antecedents(routable, ctx)


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


# Phrases that signal the model gave up and deferred the user to
# another source, or asked for clarification. When the response leads
# with any of these, a media card is almost always irrelevant — either
# the model has no grounded answer or the question was ambiguous.
_DEFERRAL_PREFIXES: tuple[str, ...] = (
    "i'm not sure",
    "i am not sure",
    "i'm not familiar",
    "i don't know",
    "i do not know",
    "i don't have",
    "i'd recommend checking",
    "i would recommend checking",
    "could you clarify",
    "can you clarify",
    "what do you mean",
    "which one do you mean",
    "which do you mean",
)


def _is_deferral_response(text: str) -> bool:
    """True when the synthesis text leads with a punt/clarification phrase."""
    if not text:
        return False
    head = text.lstrip().lower()[:60]
    return any(head.startswith(prefix) for prefix in _DEFERRAL_PREFIXES)
