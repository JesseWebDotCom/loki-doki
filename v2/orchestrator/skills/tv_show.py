"""v2 TV show adapter — wraps lokidoki.skills.tvshows_tvmaze.

The v1 TVMazeSkill exposes ``tvmaze_api`` (live) and ``local_cache``
(in-memory) mechanisms for show details and recent episodes.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.tvshows_tvmaze.skill import TVMazeSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = TVMazeSkill()

_LEAD_VERBS = (
    "tell me about the tv show ",
    "what is the tv show ",
    "what's the tv show ",
    "tell me about the show ",
    "tv show ",
    "show ",
)


def _extract_show(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not text:
        return ""
    for verb in _LEAD_VERBS:
        if text.startswith(verb):
            return text[len(verb):].strip()
    return text


def _format_success(result, method: str) -> str:
    data = result.data or {}
    name = data.get("name") or "the show"
    status = data.get("status") or ""
    network = data.get("network") or ""
    rating = data.get("rating")
    parts = [f"{name}"]
    if network:
        parts.append(f"on {network}")
    if status:
        parts.append(f"({status})")
    head = " ".join(parts)
    if rating is not None:
        return f"{head}. TVMaze rating: {rating}/10."
    return f"{head}."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    show = _extract_show(payload)
    if not show:
        return AdapterResult(
            output_text="Which TV show would you like to look up?",
            success=False,
            error="missing show",
        ).to_payload()
    attempts = [
        ("tvmaze_api", {"query": show}),
        ("local_cache", {"query": show}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=f"I couldn't reach TVMaze to look up '{show}'.",
    )
    return result.to_payload()
