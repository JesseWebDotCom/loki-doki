"""movie adapter — TMDB preferred, Wikipedia fallback.

Exposes ``lookup_movie`` (single movie detail) and ``search_movies``
(search results list). TMDB is the primary source when an API key is
configured; Wikipedia is the no-key fallback for both capabilities.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.movies_tmdb.skill import TMDBSkill
from lokidoki.skills.movies_wiki.skill import WikiMoviesSkill

from lokidoki.orchestrator.skills._config import get_skill_config
from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

_TMDB = TMDBSkill()
_WIKI = WikiMoviesSkill()


def _extract_title(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("movie_title")
    if explicit:
        return str(explicit)
    query = (payload.get("params") or {}).get("query")
    if query:
        return str(query)
    return str(payload.get("chunk_text") or "").strip(" ?.!")


def _format_tmdb(result: Any, method: str) -> str:
    data = result.data or {}
    title = data.get("title") or "Unknown"
    year = (data.get("release_date") or "")[:4]
    rating = data.get("rating")
    overview = data.get("overview") or ""
    head = f"{title} ({year})" if year else title
    parts = [head]
    if rating is not None:
        parts.append(f"TMDB rating: {rating}/10")
    if overview:
        short = overview[:200].rsplit(" ", 1)[0] if len(overview) > 200 else overview
        parts.append(short)
    return ". ".join(parts) + "."


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


async def lookup_movie(payload: dict[str, Any]) -> dict[str, Any]:
    """Look up details about a specific movie."""
    title = _extract_title(payload)
    if not title:
        return AdapterResult(
            output_text="Which movie would you like to look up?",
            success=False,
            error="missing title",
        ).to_payload()

    tmdb_key = get_skill_config("lookup_movie", "tmdb_api_key", "")
    if tmdb_key:
        _TMDB._api_key = tmdb_key

    return (await _run_lookup_mechanisms(title, tmdb_key)).to_payload()


async def _run_lookup_mechanisms(title: str, tmdb_key: str) -> "AdapterResult":
    """Try TMDB (if key provided) then Wikipedia for a movie lookup."""
    if tmdb_key:
        result = await run_mechanisms(
            _TMDB,
            [("tmdb_api", {"query": title, "_config": {"tmdb_api_key": tmdb_key}}),
             ("local_cache", {"query": title})],
            on_success=_format_tmdb,
            on_all_failed="",
        )
        if result.success:
            return result
    return await run_mechanisms(
        _WIKI,
        [("wiki_api", {"query": title}), ("local_cache", {"query": title})],
        on_success=_format_wiki,
        on_all_failed=f"I couldn't find movie details for '{title}'.",
    )


async def search_movies(payload: dict[str, Any]) -> dict[str, Any]:
    """Search for movies matching a query."""
    title = _extract_title(payload)
    if not title:
        return AdapterResult(
            output_text="What movie would you like to search for?",
            success=False,
            error="missing query",
        ).to_payload()

    tmdb_key = get_skill_config("search_movies", "tmdb_api_key", "")

    # TMDB search returns multiple results; Wikipedia search returns one.
    # Try TMDB first for richer results.
    if tmdb_key:
        result = await run_mechanisms(
            _TMDB,
            [("tmdb_api", {"query": title, "_config": {"tmdb_api_key": tmdb_key}})],
            on_success=_format_tmdb,
            on_all_failed="",
        )
        if result.success:
            return result.to_payload()

    # Fallback to Wikipedia.
    result = await run_mechanisms(
        _WIKI,
        [("wiki_api", {"query": title}), ("local_cache", {"query": title})],
        on_success=_format_wiki,
        on_all_failed=f"I couldn't find any movies matching '{title}'.",
    )
    return result.to_payload()
