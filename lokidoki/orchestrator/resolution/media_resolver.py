"""Media resolver for the pipeline.

Handles "that movie" / "the film" / "what was that movie" by reading the
:class:`MovieContextAdapter`. Ambiguity (multiple recent movies) and
absence (no recent movie at all) are surfaced explicitly so the
combiner can decide whether to ask the user, fall through to LLM, or
deliver a clean answer.
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.movie_context import MovieContextAdapter
from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch

# Capabilities that *always* require recent-media context lookup.
# These are intrinsically about a previously-mentioned title.
_ALWAYS_MEDIA = {"recall_recent_media", "get_movie_rating"}

# Capabilities that *optionally* use recent-media context — only when
# the chunk text contains a referent pronoun instead of an explicit title.
_PRONOUN_MEDIA = {"lookup_movie", "search_movies"}

MEDIA_CAPABILITIES = _ALWAYS_MEDIA | _PRONOUN_MEDIA

_REFERENT_PRONOUNS = {"it", "its", "that", "this", "them"}


def _no_recent_media(chunk: RequestChunk, route: RouteMatch) -> ResolutionResult:
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target="recent movie",
        source="unresolved_context",
        confidence=route.confidence,
        unresolved=["recent_media"],
        notes=["no recent movie in conversation context"],
    )


def _ambiguous_media(chunk: RequestChunk, route: RouteMatch, movies: list) -> ResolutionResult:
    names = [movie.title for movie in movies]
    primary = movies[0]
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=primary.title,
        source="ambiguous_context",
        confidence=route.confidence,
        candidate_values=names,
        unresolved=["recent_media_ambiguous"],
        params={"movie_id": primary.movie_id, "movie_title": primary.title},
        notes=[f"{len(movies)} recent movies match"],
    )


def _resolved_media(chunk: RequestChunk, route: RouteMatch, movie) -> ResolutionResult:
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=movie.title,
        source="recent_context",
        confidence=route.confidence,
        context_value=movie.title,
        params={"movie_id": movie.movie_id, "movie_title": movie.title},
    )


def resolve_media(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    adapter: MovieContextAdapter,
) -> ResolutionResult | None:
    if route.capability not in MEDIA_CAPABILITIES:
        return None

    # For lookup_movie/search_movies, only resolve from context when the
    # chunk uses a pronoun instead of an explicit title. "have you seen
    # the movie inception" should NOT go through media resolution — the
    # handler reads the title from the chunk text.
    if route.capability in _PRONOUN_MEDIA:
        if not _has_referent_pronoun(chunk.text):
            return None

    movies = adapter.recent_movies()
    if not movies:
        return _no_recent_media(chunk, route)
    if len(movies) > 1:
        return _ambiguous_media(chunk, route, movies)
    return _resolved_media(chunk, route, movies[0])


def _has_referent_pronoun(text: str) -> bool:
    """True when the chunk text contains a referent pronoun."""
    tokens = set(text.lower().split())
    return bool(tokens & _REFERENT_PRONOUNS)
