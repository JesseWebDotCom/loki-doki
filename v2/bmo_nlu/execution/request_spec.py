"""RequestSpec builder for the v2 prototype."""
from __future__ import annotations

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
) -> RequestSpec:
    """Build the structured snapshot used before final combination."""
    route_by_chunk = {item.chunk_index: item for item in routes}
    implementation_by_chunk = {item.chunk_index: item for item in implementations}
    resolution_by_chunk = {item.chunk_index: item for item in resolutions}
    execution_by_chunk = {item.chunk_index: item for item in executions}

    spec_chunks: list[RequestChunkResult] = []
    for chunk in chunks:
        route = route_by_chunk[chunk.index]
        implementation = implementation_by_chunk[chunk.index]
        resolution = resolution_by_chunk[chunk.index]
        execution = execution_by_chunk[chunk.index]
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
                },
                result={
                    "output_text": execution.output_text,
                },
                success=True,
                unresolved=[],
            )
        )

    return RequestSpec(
        trace_id=f"v2-{abs(hash(raw_text)) % 1_000_000:06d}",
        original_request=raw_text,
        chunks=spec_chunks,
        supporting_context=[],
        context={},
        runtime_version=2,
    )
