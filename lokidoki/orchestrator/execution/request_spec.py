"""RequestSpec builder for the pipeline."""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    ImplementationSelection,
    RequestChunk,
    RequestChunkResult,
    RequestSpec,
    ResolutionResult,
    RouteMatch,
)


def build_request_spec(
    *,
    raw_text: str,
    chunks: list[RequestChunk],
    routes: list[RouteMatch],
    implementations: list[ImplementationSelection],
    resolutions: list[ResolutionResult],
    executions: list[ExecutionResult],
    context: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> RequestSpec:
    route_by_chunk = {item.chunk_index: item for item in routes}
    implementation_by_chunk = {item.chunk_index: item for item in implementations}
    resolution_by_chunk = {item.chunk_index: item for item in resolutions}
    execution_by_chunk = {item.chunk_index: item for item in executions}
    safe_context = context or {}

    spec_chunks: list[RequestChunkResult] = []
    supporting_context: list[str] = []

    for chunk in chunks:
        route = route_by_chunk.get(chunk.index)
        implementation = implementation_by_chunk.get(chunk.index)
        resolution = resolution_by_chunk.get(chunk.index)
        execution = execution_by_chunk.get(chunk.index)

        if chunk.role == "supporting_context":
            supporting_context.append(chunk.text)
            # Subordinate-clause chunks are not routed/executed, but they
            # still belong in spec.chunks so the LLM decider and any
            # downstream consumer can see them as first-class entries.
            spec_chunks.append(
                RequestChunkResult(
                    text=chunk.text,
                    role=chunk.role,
                    capability="",
                    confidence=0.0,
                )
            )
            continue

        if route is None or implementation is None or resolution is None or execution is None:
            continue

        unresolved = list(resolution.unresolved)
        success = execution.success and not unresolved
        error = execution.error or _resolution_error(resolution)

        spec_chunks.append(
            RequestChunkResult(
                text=chunk.text,
                role=chunk.role,
                capability=route.capability,
                confidence=route.confidence,
                handler_name=implementation.handler_name,
                implementation_id=implementation.implementation_id,
                candidate_count=implementation.candidate_count,
                params={
                    "resolved_target": resolution.resolved_target,
                    "source": resolution.source,
                    "candidates": resolution.candidate_values,
                    **resolution.params,
                },
                result={
                    "output_text": execution.output_text,
                    **execution.raw_result,
                },
                success=success,
                error=error,
                unresolved=unresolved,
            )
        )

    supporting_context.extend(_supporting_from_resolutions(resolutions))

    return RequestSpec(
        trace_id=trace_id or f"lk-{abs(hash(raw_text)) % 1_000_000:06d}",
        original_request=raw_text,
        chunks=spec_chunks,
        supporting_context=supporting_context,
        context=safe_context,
        runtime_version=2,
    )


def _supporting_from_resolutions(resolutions: list[ResolutionResult]) -> list[str]:
    out: list[str] = []
    for item in resolutions:
        if item.source == "recent_context" and item.context_value:
            out.append(f"movie:{item.context_value}")
        elif item.source == "ambiguous_context":
            out.extend(f"movie:{candidate}" for candidate in item.candidate_values)
    return out


def _resolution_error(resolution: ResolutionResult) -> str | None:
    if resolution.source == "unresolved_context":
        return "missing recent movie context"
    if resolution.source == "ambiguous_context":
        return "multiple recent movies match"
    if resolution.source == "ambiguous_person":
        return "multiple people match"
    if resolution.source == "unresolved_person":
        return "could not resolve person"
    if resolution.source == "ambiguous_device":
        return "multiple devices match"
    if resolution.source == "unresolved_device":
        return "could not resolve device"
    if resolution.source in {"ambiguous_referent", "unresolved_referent"}:
        return "ambiguous or missing referent"
    return None
