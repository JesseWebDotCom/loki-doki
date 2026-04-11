"""Top-level deterministic v2 request pipeline."""
from __future__ import annotations

from v2.bmo_nlu.core.types import ParsedInput, PipelineResult, ResponseObject, TraceData
from v2.bmo_nlu.execution.executor import execute_chunk
from v2.bmo_nlu.pipeline.combiner import combine_outputs
from v2.bmo_nlu.pipeline.extractor import extract_chunk_data
from v2.bmo_nlu.pipeline.fast_lane import check_fast_lane
from v2.bmo_nlu.pipeline.normalizer import normalize_text
from v2.bmo_nlu.pipeline.parser import parse_text
from v2.bmo_nlu.pipeline.splitter import split_requests
from v2.bmo_nlu.resolution.resolver import resolve_chunks
from v2.bmo_nlu.routing.router import route_chunk
from v2.bmo_nlu.signals.interaction_signals import detect_interaction_signals


def run_pipeline(raw_text: str) -> PipelineResult:
    """Run the current Phase 1 v2 prototype pipeline."""
    trace = TraceData()

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
            resolutions=[],
            executions=[],
            response=response,
            trace=trace,
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
    routes = [route_chunk(chunk) for chunk in chunks]
    finish(
        capabilities=[route.capability for route in routes],
        confidences=[route.confidence for route in routes],
    )

    finish = trace.timed("resolve")
    resolutions = resolve_chunks(chunks, extractions, routes)
    finish(
        resolved_targets=[item.resolved_target for item in resolutions],
        sources=[item.source for item in resolutions],
    )

    finish = trace.timed("execute")
    executions = [
        execute_chunk(chunk, route, resolution)
        for chunk, route, resolution in zip(chunks, routes, resolutions, strict=True)
    ]
    finish(
        count=len(executions),
        outputs=[execution.output_text for execution in executions],
    )

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
        resolutions=resolutions,
        executions=executions,
        response=response,
        trace=trace,
    )
