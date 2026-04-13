"""movie adapter — parallel primary + web-search lookup with scoring.

The primary source is the movie-specific Wikipedia skill (which handles
film disambiguation, runtime extraction, and franchise "latest" logic).
TMDB is prepended as an additional primary when an API key is
configured. Web search (DuckDuckGo) runs as the generic secondary via
the shared ``web_search_source`` so new/swapped search backends are
picked up automatically.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.movies_wiki.skill import WikiMoviesSkill

from lokidoki.orchestrator.skills._config import get_skill_config
from lokidoki.orchestrator.skills._runner import (
    AdapterResult,
    run_mechanisms,
    run_sources_parallel_scored,
    score_subject_coverage,
    web_search_source,
)

_WIKI = WikiMoviesSkill()

MIN_SUBJECT_COVERAGE = 0.5


def _extract_title(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("movie_title")
    if explicit:
        return str(explicit)
    query = (payload.get("params") or {}).get("query")
    if query:
        return str(query)
    return str(payload.get("chunk_text") or "").strip(" ?.!")


def _format_wiki(result: Any, method: str) -> str:
    data = result.data or {}
    lead = str(data.get("lead") or "").strip()
    if lead:
        return lead
    title = data.get("title") or "Unknown"
    overview = data.get("overview") or ""
    if overview:
        first = overview.split(". ", 1)[0].rstrip(".")
        return f"{first}."
    return f"I found information on {title} but couldn't extract a summary."


async def _wiki_source(title: str) -> AdapterResult:
    """Movie-specific Wikipedia source — handles film disambiguation."""
    return await run_mechanisms(
        _WIKI,
        [("wiki_api", {"query": title}), ("local_cache", {"query": title})],
        on_success=_format_wiki,
        on_all_failed=f"Wikipedia had nothing on '{title}'.",
    )


async def _tmdb_source(title: str, tmdb_key: str) -> AdapterResult:
    """Optional TMDB source — only used when API key is configured."""
    from lokidoki.skills.movies_tmdb.skill import TMDBSkill

    skill: TMDBSkill = getattr(_tmdb_source, "_skill", None)  # type: ignore[assignment]
    if skill is None:
        skill = TMDBSkill()
        _tmdb_source._skill = skill  # type: ignore[attr-defined]
    skill._api_key = tmdb_key

    def _format_tmdb(result: Any, method: str) -> str:
        data = result.data or {}
        t = data.get("title") or "Unknown"
        year = (data.get("release_date") or "")[:4]
        rating = data.get("rating")
        overview = data.get("overview") or ""
        head = f"{t} ({year})" if year else t
        parts = [head]
        if rating is not None:
            parts.append(f"TMDB rating: {rating}/10")
        if overview:
            short = overview[:200].rsplit(" ", 1)[0] if len(overview) > 200 else overview
            parts.append(short)
        return ". ".join(parts) + "."

    return await run_mechanisms(
        skill,
        [
            ("tmdb_api", {"query": title, "_config": {"tmdb_api_key": tmdb_key}}),
            ("local_cache", {"query": title}),
        ],
        on_success=_format_tmdb,
        on_all_failed="",
    )


async def lookup_movie(payload: dict[str, Any]) -> dict[str, Any]:
    """Look up details about a specific movie."""
    title = _extract_title(payload)
    if not title:
        return AdapterResult(
            output_text="Which movie would you like to look up?",
            success=False,
            error="missing title",
        ).to_payload()

    def score(result: AdapterResult) -> float:
        return score_subject_coverage(title, result.output_text)

    sources: list[tuple[str, Any]] = [
        ("movie_wiki", _wiki_source(title)),
        ("web", web_search_source(f"{title} movie")),
    ]
    tmdb_key = get_skill_config("lookup_movie", "tmdb_api_key", "")
    if tmdb_key:
        sources.insert(0, ("tmdb", _tmdb_source(title, tmdb_key)))

    result = await run_sources_parallel_scored(
        sources,
        score=score,
        threshold=MIN_SUBJECT_COVERAGE,
        fallback_text=f"I couldn't find movie details for '{title}'.",
    )
    return result.to_payload()


async def search_movies(payload: dict[str, Any]) -> dict[str, Any]:
    """Search for movies matching a query."""
    title = _extract_title(payload)
    if not title:
        return AdapterResult(
            output_text="What movie would you like to search for?",
            success=False,
            error="missing query",
        ).to_payload()

    def score(result: AdapterResult) -> float:
        return score_subject_coverage(title, result.output_text)

    sources: list[tuple[str, Any]] = [
        ("movie_wiki", _wiki_source(title)),
        ("web", web_search_source(f"{title} movie")),
    ]
    tmdb_key = get_skill_config("search_movies", "tmdb_api_key", "")
    if tmdb_key:
        sources.insert(0, ("tmdb", _tmdb_source(title, tmdb_key)))

    result = await run_sources_parallel_scored(
        sources,
        score=score,
        threshold=MIN_SUBJECT_COVERAGE,
        fallback_text=f"I couldn't find any movies matching '{title}'.",
    )
    return result.to_payload()
