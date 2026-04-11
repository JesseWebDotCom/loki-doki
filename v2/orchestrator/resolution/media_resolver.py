"""Media resolver for the v2 prototype.

Handles "that movie" / "the film" / "what was that movie" by reading the
:class:`MovieContextAdapter`. Ambiguity (multiple recent movies) and
absence (no recent movie at all) are surfaced explicitly so the
combiner can decide whether to ask the user, fall through to Gemma, or
deliver a clean answer.
"""
from __future__ import annotations

from v2.orchestrator.adapters.movie_context import MovieContextAdapter
from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch

# Only capabilities that are *intrinsically* about a previously-mentioned
# title go through the recent-media context lookup. Capabilities like
# ``get_movie_showtimes`` carry their title in the chunk text itself
# ("the new mario movie"), so the handler reads the chunk directly and
# does not need this resolver to bind a recent context entity.
MEDIA_CAPABILITIES = {
    "recall_recent_media",
    "get_movie_rating",
}


def resolve_media(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    adapter: MovieContextAdapter,
) -> ResolutionResult | None:
    if route.capability not in MEDIA_CAPABILITIES:
        return None

    movies = adapter.recent_movies()

    if not movies:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="recent movie",
            source="unresolved_context",
            confidence=route.confidence,
            unresolved=["recent_media"],
            notes=["no recent movie in conversation context"],
        )

    if len(movies) > 1:
        names = [movie.title for movie in movies]
        primary = movies[0]
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target=primary.title,
            source="ambiguous_context",
            confidence=route.confidence,
            candidate_values=names,
            unresolved=["recent_media_ambiguous"],
            params={
                "movie_id": primary.movie_id,
                "movie_title": primary.title,
            },
            notes=[f"{len(movies)} recent movies match"],
        )

    movie = movies[0]
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=movie.title,
        source="recent_context",
        confidence=route.confidence,
        context_value=movie.title,
        params={
            "movie_id": movie.movie_id,
            "movie_title": movie.title,
        },
    )
