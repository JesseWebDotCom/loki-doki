"""Resolver stage for the v2 prototype."""
from __future__ import annotations

import asyncio

from v2.bmo_nlu.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch


def resolve_chunks(
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
) -> list[ResolutionResult]:
    """Resolve routed chunks to concrete targets using extracted references."""
    resolutions: list[ResolutionResult] = []
    extraction_by_chunk = {item.chunk_index: item for item in extractions}

    for chunk, route in zip(chunks, routes, strict=True):
        extraction = extraction_by_chunk.get(chunk.index)
        resolved_target = route.capability
        source = "route"

        if route.capability == "get_current_time":
            resolved_target = "current_time"
            source = "direct_utility"
        elif route.capability == "spell_word" and extraction and extraction.references:
            resolved_target = extraction.references[0]
            source = "chunk_reference"
        elif route.capability == "greeting_response":
            resolved_target = "greeting"
            source = "direct_utility"

        resolutions.append(
            ResolutionResult(
                chunk_index=chunk.index,
                resolved_target=resolved_target,
                source=source,
                confidence=route.confidence,
            )
        )

    return resolutions


async def resolve_chunk_async(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
) -> ResolutionResult:
    """Async wrapper for per-chunk resolution."""
    await asyncio.sleep(0)
    resolved = resolve_chunks([chunk], [extraction], [route])
    return resolved[0]
