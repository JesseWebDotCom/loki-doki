"""RequestSpec builder for the v2 prototype."""
from __future__ import annotations

from typing import Any

from v2.bmo_nlu.core.types import (
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
) -> RequestSpec:
    """Build the structured snapshot used before final combination."""
    route_by_chunk = {item.chunk_index: item for item in routes}
    implementation_by_chunk = {item.chunk_index: item for item in implementations}
    resolution_by_chunk = {item.chunk_index: item for item in resolutions}
    execution_by_chunk = {item.chunk_index: item for item in executions}
    safe_context = context or {}

    spec_chunks: list[RequestChunkResult] = []
    for chunk in chunks:
        route = route_by_chunk[chunk.index]
        implementation = implementation_by_chunk[chunk.index]
        resolution = resolution_by_chunk[chunk.index]
        execution = execution_by_chunk[chunk.index]
        unresolved = _build_unresolved_markers(route, resolution)
        error = _build_error_message(route, resolution)
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
                },
                result={
                    "output_text": execution.output_text,
                },
                success=not unresolved,
                error=error,
                unresolved=unresolved,
            )
        )

    return RequestSpec(
        trace_id=f"v2-{abs(hash(raw_text)) % 1_000_000:06d}",
        original_request=raw_text,
        chunks=spec_chunks,
        supporting_context=_build_supporting_context(resolutions),
        context=safe_context,
        runtime_version=2,
    )


def _build_supporting_context(resolutions: list[ResolutionResult]) -> list[str]:
    supporting: list[str] = []
    for item in resolutions:
        if item.source == "recent_context" and item.context_value:
            supporting.append(f"movie:{item.context_value}")
        elif item.source == "ambiguous_context":
            supporting.extend(f"movie:{candidate}" for candidate in item.candidate_values)
    return supporting


def _build_unresolved_markers(route: RouteMatch, resolution: ResolutionResult) -> list[str]:
    if route.capability == "recall_recent_media" and resolution.source == "unresolved_context":
        return ["recent_media"]
    if route.capability == "recall_recent_media" and resolution.source == "ambiguous_context":
        return ["recent_media_ambiguous"]
    return []


def _build_error_message(route: RouteMatch, resolution: ResolutionResult) -> str | None:
    if route.capability == "recall_recent_media" and resolution.source == "unresolved_context":
        return "missing recent movie context"
    if route.capability == "recall_recent_media" and resolution.source == "ambiguous_context":
        return "multiple recent movies match"
    return None
