"""Resolver stage for the v2 prototype."""
from __future__ import annotations

import asyncio
from typing import Any

from v2.bmo_nlu.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch


def resolve_chunks(
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
    context: dict[str, Any] | None = None,
) -> list[ResolutionResult]:
    """Resolve routed chunks to concrete targets using extracted references."""
    resolutions: list[ResolutionResult] = []
    extraction_by_chunk = {item.chunk_index: item for item in extractions}
    recent_media = _pick_recent_media(context)

    for chunk, route in zip(chunks, routes, strict=True):
        extraction = extraction_by_chunk.get(chunk.index)
        resolved_target = route.capability
        source = "route"
        context_value: str | None = None
        candidate_values: list[str] = []

        if route.capability == "get_current_time":
            resolved_target = "current_time"
            source = "direct_utility"
        elif route.capability == "spell_word" and extraction and extraction.references:
            resolved_target = extraction.references[0]
            source = "chunk_reference"
        elif route.capability == "recall_recent_media":
            if len(recent_media) == 1:
                resolved_target = recent_media[0]
                source = "recent_context"
                context_value = recent_media[0]
            elif len(recent_media) > 1:
                resolved_target = recent_media[0]
                source = "ambiguous_context"
                candidate_values = recent_media
            else:
                resolved_target = "recent movie"
                source = "unresolved_context"
        elif route.capability == "greeting_response":
            resolved_target = "greeting"
            source = "direct_utility"

        resolutions.append(
            ResolutionResult(
                chunk_index=chunk.index,
                resolved_target=resolved_target,
                source=source,
                confidence=route.confidence,
                context_value=context_value,
                candidate_values=candidate_values,
            )
        )

    return resolutions


async def resolve_chunk_async(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    context: dict[str, Any] | None = None,
) -> ResolutionResult:
    """Async wrapper for per-chunk resolution."""
    await asyncio.sleep(0)
    resolved = resolve_chunks([chunk], [extraction], [route], context)
    return resolved[0]


def _pick_recent_media(context: dict[str, Any] | None) -> list[str]:
    if not context:
        return []
    entities = context.get("recent_entities")
    if not isinstance(entities, list):
        return []
    names: list[str] = []
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        entity_type = str(entity.get("type") or "").lower()
        if entity_type not in {"movie", "film", "media", "tv_show"}:
            continue
        name = str(entity.get("name") or "").strip()
        if name:
            names.append(name)
    return names
