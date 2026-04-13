"""Resolver orchestrator for the pipeline.

The orchestrator decides which sub-resolver (people / media / device /
pronoun) is responsible for a chunk based on the routed capability and
the extracted references, then falls back to a deterministic default
that simply echoes the route. Resolvers never silently guess: ambiguous
or missing data surfaces in :attr:`ResolutionResult.unresolved`.
"""
from __future__ import annotations

import asyncio
from typing import Any

from lokidoki.orchestrator.adapters import (
    ConversationMemoryAdapter,
    HomeAssistantAdapter,
    LokiSmartHomeAdapter,
    MovieContextAdapter,
    PeopleDBAdapter,
)
from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch
from lokidoki.orchestrator.resolution.device_resolver import resolve_device
from lokidoki.orchestrator.resolution.media_resolver import resolve_media
from lokidoki.orchestrator.resolution.people_resolver import resolve_people
from lokidoki.orchestrator.resolution.pronoun_resolver import resolve_pronouns


def resolve_chunks(
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
    context: dict[str, Any] | None = None,
) -> list[ResolutionResult]:
    memory = ConversationMemoryAdapter(context)
    movies = MovieContextAdapter(memory)
    people = PeopleDBAdapter()
    devices: HomeAssistantAdapter | LokiSmartHomeAdapter = (
        (context or {}).get("device_adapter") or LokiSmartHomeAdapter()
    )

    need_session_context = bool((context or {}).get("need_session_context"))

    extraction_by_chunk = {item.chunk_index: item for item in extractions}
    out: list[ResolutionResult] = []
    for chunk, route in zip(chunks, routes, strict=True):
        extraction = extraction_by_chunk.get(chunk.index) or ChunkExtraction(chunk_index=chunk.index)
        out.append(_resolve_one(
            chunk, extraction, route, memory, movies, people, devices,
            need_session_context=need_session_context,
        ))
    return out


def _resolve_one(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    memory: ConversationMemoryAdapter,
    movies: MovieContextAdapter,
    people: PeopleDBAdapter,
    devices: HomeAssistantAdapter | LokiSmartHomeAdapter,
    *,
    need_session_context: bool = False,
) -> ResolutionResult:
    media = resolve_media(
        chunk, extraction, route, movies,
        need_session_context=need_session_context,
    )
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


_ENTITY_BEARING_CAPABILITIES = frozenset({
    "lookup_movie", "search_movies", "lookup_tv_show",
    "get_episode_detail", "get_movie_showtimes",
})


def _default_resolution(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
) -> ResolutionResult:
    entity_result = _resolve_direct_entity(chunk, route)
    if entity_result is not None:
        return entity_result

    spell_result = _resolve_spell_word(chunk, extraction, route)
    if spell_result is not None:
        return spell_result

    entity_from_text = _resolve_entity_from_text(chunk, extraction, route)
    if entity_from_text is not None:
        return entity_from_text

    return _fallback_resolution(chunk, route)


def _resolve_direct_entity(
    chunk: RequestChunk,
    route: RouteMatch,
) -> ResolutionResult | None:
    """Return a direct-utility result for well-known zero-arg capabilities."""
    _DIRECT: dict[str, str] = {
        "get_current_time": "current_time",
        "get_current_date": "current_date",
        "greeting_response": "greeting",
        "acknowledgment_response": "acknowledgment",
    }
    target = _DIRECT.get(route.capability)
    if target is None:
        return None
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=target,
        source="direct_utility",
        confidence=route.confidence,
    )


def _resolve_spell_word(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
) -> ResolutionResult | None:
    """Return a spell-word result, or None if capability is not spell_word."""
    if route.capability != "spell_word":
        return None
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


def _resolve_entity_from_text(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
) -> ResolutionResult | None:
    """Extract an entity name from the chunk text for entity-bearing capabilities."""
    if route.capability not in _ENTITY_BEARING_CAPABILITIES:
        return None
    # Use the last subject_candidate (typically the entity name, e.g. "inception")
    candidates = extraction.subject_candidates or []
    # Filter out pronouns and short words
    names = [c for c in candidates if len(c) > 2 and c.lower() not in {"you", "the", "who"}]
    if not names:
        return None
    target = names[-1]
    # Strip common determiner prefixes ("the movie X" → "X")
    for prefix in ("the movie ", "the film ", "the show ", "the tv show "):
        if target.lower().startswith(prefix):
            target = target[len(prefix):]
            break
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=target,
        source="chunk_entity",
        confidence=route.confidence,
        params={"entity_type": "movie"},
    )


def _fallback_resolution(
    chunk: RequestChunk,
    route: RouteMatch,
) -> ResolutionResult:
    """Last-resort: echo the capability name as the resolved target."""
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=route.capability,
        source="route",
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
