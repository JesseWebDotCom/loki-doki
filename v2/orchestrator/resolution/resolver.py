"""Resolver orchestrator for the v2 prototype.

The orchestrator decides which sub-resolver (people / media / device /
pronoun) is responsible for a chunk based on the routed capability and
the extracted references, then falls back to a deterministic default
that simply echoes the route. Resolvers never silently guess: ambiguous
or missing data surfaces in :attr:`ResolutionResult.unresolved`.
"""
from __future__ import annotations

import asyncio
from typing import Any

from v2.orchestrator.adapters import (
    ConversationMemoryAdapter,
    HomeAssistantAdapter,
    MovieContextAdapter,
    PeopleDBAdapter,
)
from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch
from v2.orchestrator.resolution.device_resolver import resolve_device
from v2.orchestrator.resolution.media_resolver import resolve_media
from v2.orchestrator.resolution.people_resolver import resolve_people
from v2.orchestrator.resolution.pronoun_resolver import resolve_pronouns


def resolve_chunks(
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
    context: dict[str, Any] | None = None,
) -> list[ResolutionResult]:
    memory = ConversationMemoryAdapter(context)
    movies = MovieContextAdapter(memory)
    people = PeopleDBAdapter()
    devices = HomeAssistantAdapter()

    extraction_by_chunk = {item.chunk_index: item for item in extractions}
    out: list[ResolutionResult] = []
    for chunk, route in zip(chunks, routes, strict=True):
        extraction = extraction_by_chunk.get(chunk.index) or ChunkExtraction(chunk_index=chunk.index)
        out.append(_resolve_one(chunk, extraction, route, memory, movies, people, devices))
    return out


def _resolve_one(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    memory: ConversationMemoryAdapter,
    movies: MovieContextAdapter,
    people: PeopleDBAdapter,
    devices: HomeAssistantAdapter,
) -> ResolutionResult:
    media = resolve_media(chunk, extraction, route, movies)
    if media is not None:
        return media

    person = resolve_people(chunk, extraction, route, people)
    if person is not None:
        return person

    device = resolve_device(chunk, extraction, route, devices)
    if device is not None:
        return device

    pronoun = resolve_pronouns(chunk, extraction, route, memory)
    if pronoun is not None:
        return pronoun

    return _default_resolution(chunk, extraction, route)


def _default_resolution(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
) -> ResolutionResult:
    capability = route.capability
    resolved_target = capability
    source = "route"

    if capability == "get_current_time":
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="current_time",
            source="direct_utility",
            confidence=route.confidence,
        )
    if capability == "get_current_date":
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="current_date",
            source="direct_utility",
            confidence=route.confidence,
        )
    if capability == "spell_word":
        word = _extract_spell_target(chunk.text, extraction)
        if word:
            return ResolutionResult(
                chunk_index=chunk.index,
                resolved_target=word,
                source="chunk_reference",
                confidence=route.confidence,
            )
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="",
            source="missing_spell_target",
            confidence=route.confidence,
            unresolved=["spell:missing"],
        )
    if capability == "greeting_response":
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="greeting",
            source="direct_utility",
            confidence=route.confidence,
        )
    if capability == "acknowledgment_response":
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="acknowledgment",
            source="direct_utility",
            confidence=route.confidence,
        )

    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=resolved_target,
        source=source,
        confidence=route.confidence,
    )


def _extract_spell_target(chunk_text: str, extraction: ChunkExtraction) -> str:
    """Pull the word that follows ``spell`` from a routed spell-word chunk."""
    text = (chunk_text or "").strip().lower().rstrip("?.!,")
    if not text:
        return ""
    if " spell " in f" {text} ":
        idx = text.rfind("spell ")
        tail = text[idx + len("spell "):].strip()
        if tail:
            return tail.split()[-1]
    if extraction.subject_candidates:
        return extraction.subject_candidates[-1].lower()
    words = text.split()
    return words[-1] if words else ""


async def resolve_chunk_async(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    context: dict[str, Any] | None = None,
) -> ResolutionResult:
    """Offload sync resolver work to a thread."""
    resolved = await asyncio.to_thread(resolve_chunks, [chunk], [extraction], [route], context)
    return resolved[0]
