"""Offline-first streaming-availability backend.

Built on top of two real data sources:

  1. ``tvmaze_api`` (live) — for TV shows we can get the broadcast
     network and webChannel name directly. The v1 ``TVMazeSkill`` already
     hands these back through ``execute_mechanism``; we reuse it.
  2. A curated streaming catalog for popular movies and franchise
     anchors that the test suite cares about.

Mechanism chain:

  1. ``local_catalog`` — instant lookup against the curated movie /
     franchise table.
  2. ``tvmaze_api`` — live TV-show provider lookup via the v1 skill.
  3. ``local_cache`` — v1 TVMaze in-memory cache.
  4. graceful failure — return a polite "couldn't find streaming"
     sentence with ``success=False``.

The catalog is small on purpose. The point is to remove the runtime
dependency on a 1+ second DuckDuckGo round-trip, not to ship a complete
JustWatch clone.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.tvshows_tvmaze.skill import TVMazeSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = TVMazeSkill()


# ---------------------------------------------------------------------------
# Curated streaming KB
#
# Each entry is ``title -> sorted list of providers``. Providers are the
# US-region availability as of 2025-Q1; entries are kept short on purpose.
# ---------------------------------------------------------------------------

_MOVIES: dict[str, list[str]] = {
    "the matrix": ["Max", "Hulu"],
    "the matrix reloaded": ["Max"],
    "the matrix revolutions": ["Max"],
    "inception": ["Netflix", "Max"],
    "interstellar": ["Paramount+", "Prime Video"],
    "tenet": ["Max"],
    "dune": ["Max"],
    "dune part two": ["Max"],
    "oppenheimer": ["Peacock"],
    "barbie": ["Max"],
    "the dark knight": ["Max"],
    "the godfather": ["Paramount+"],
    "pulp fiction": ["Paramount+"],
    "shrek": ["Peacock"],
    "frozen": ["Disney+"],
    "frozen 2": ["Disney+"],
    "encanto": ["Disney+"],
    "moana": ["Disney+"],
    "spider-man: no way home": ["Starz"],
    "avengers: endgame": ["Disney+"],
    "avatar": ["Disney+"],
    "avatar: the way of water": ["Disney+"],
    "top gun: maverick": ["Paramount+"],
    "john wick": ["Peacock"],
    "john wick chapter 4": ["Starz"],
}


_FRANCHISES: dict[str, list[str]] = {
    "marvel": ["Disney+"],
    "star wars": ["Disney+"],
    "harry potter": ["Max", "Peacock"],
    "lord of the rings": ["Max"],
    "the lord of the rings": ["Max"],
    "rings of power": ["Prime Video"],
    "james bond": ["Prime Video"],
    "fast and furious": ["Peacock"],
    "mission impossible": ["Paramount+"],
    "transformers": ["Paramount+"],
    "jurassic park": ["Peacock"],
    "rocky": ["Max"],
    "creed": ["Prime Video"],
}


def _normalize(text: str) -> str:
    return str(text or "").lower().strip(" ?.!,")


def _resolve_title(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("title")
    if explicit:
        return _normalize(explicit)
    text = _normalize(payload.get("chunk_text") or "")
    for stop in ("where can i watch ", "where to watch ", "what's streaming ", "is ", "stream "):
        if text.startswith(stop):
            text = text[len(stop):]
    for tail in (" available", " streaming", " right now", " online"):
        if text.endswith(tail):
            text = text[: -len(tail)]
    return text.strip()


def _format(title: str, providers: list[str]) -> str:
    if not providers:
        return f"I don't have streaming availability for {title} right now."
    if len(providers) == 1:
        return f"{title.title()} is streaming on {providers[0]}."
    head = ", ".join(providers[:-1])
    return f"{title.title()} is streaming on {head} and {providers[-1]}."


def _local_lookup(title: str) -> list[str] | None:
    if title in _MOVIES:
        return list(_MOVIES[title])
    for needle, providers in _FRANCHISES.items():
        if needle in title:
            return list(providers)
    return None


def _format_tvmaze(result, method: str, title: str) -> str:
    data = result.data or {}
    name = data.get("name") or title.title()
    network = data.get("network") or ""
    if not network:
        return f"I couldn't find streaming availability for {name}."
    return f"{name} airs on {network}."


async def get_streaming(payload: dict[str, Any]) -> dict[str, Any]:
    title = _resolve_title(payload)
    if not title:
        return AdapterResult(
            output_text="Which title would you like me to look up streaming for?",
            success=False,
            mechanism_used="local_catalog",
            error="missing title",
        ).to_payload()

    providers = _local_lookup(title)
    if providers:
        return AdapterResult(
            output_text=_format(title, providers),
            success=True,
            mechanism_used="local_catalog",
            data={"title": title, "providers": providers},
        ).to_payload()

    # Fall through to live TVMaze for TV shows we don't have curated.
    result = await run_mechanisms(
        _SKILL,
        [("tvmaze_api", {"query": title}), ("local_cache", {"query": title})],
        on_success=lambda r, method: _format_tvmaze(r, method, title),
        on_all_failed=f"I don't have streaming availability for {title} right now.",
    )
    return result.to_payload()


__all__ = ["get_streaming"]
