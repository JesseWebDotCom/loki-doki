"""Live sports lookups backed by generic web search."""
from __future__ import annotations

from typing import Any

from v2.orchestrator.skills import search_web


async def get_score(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("team_or_game") or payload.get("chunk_text") or "").strip()
    return await search_web._search(f"{query} score", fallback_message="I couldn't find that game score right now.")


async def get_standings(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await search_web._search(f"{query} standings", fallback_message="I couldn't find those standings right now.")


async def get_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("team_or_league") or payload.get("chunk_text") or "").strip()
    return await search_web._search(f"{query} schedule", fallback_message="I couldn't find that schedule right now.")


async def get_player_stats(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return await search_web._search(f"{query} stats", fallback_message="I couldn't find those player stats right now.")
