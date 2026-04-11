"""Sports adapters backed by ESPN public JSON endpoints."""
from __future__ import annotations

import re
from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_LEAGUES = {
    "nba": ("basketball", "nba"),
    "wnba": ("basketball", "wnba"),
    "nfl": ("football", "nfl"),
    "mlb": ("baseball", "mlb"),
    "nhl": ("hockey", "nhl"),
}

_TEAM_ALIASES = {
    "lakers": ("basketball", "nba"),
    "celtics": ("basketball", "nba"),
    "yankees": ("baseball", "mlb"),
    "red sox": ("baseball", "mlb"),
    "chiefs": ("football", "nfl"),
}

_BASE = "https://site.api.espn.com/apis/site/v2/sports"


def _sport_league(text: str) -> tuple[str, str]:
    lower = text.lower()
    for key, value in _LEAGUES.items():
        if key in lower:
            return value
    for alias, value in _TEAM_ALIASES.items():
        if alias in lower:
            return value
    return ("basketball", "nba")


async def _get(url: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=6.0) as client:
        response = await client.get(url, headers={"User-Agent": "LokiDoki/0.2"})
    if response.status_code != 200:
        return None
    return response.json()


async def get_score(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    sport, league = _sport_league(text)
    data = await _get(f"{_BASE}/{sport}/{league}/scoreboard")
    if not data:
        return AdapterResult(output_text="I couldn't find that score right now.", success=False, error="scoreboard failed").to_payload()
    query = text.lower()
    for event in data.get("events") or []:
        name = (event.get("name") or "").lower()
        if any(term in name for term in query.split()):
            comp = (event.get("competitions") or [{}])[0]
            teams = comp.get("competitors") or []
            if len(teams) >= 2:
                left = teams[0]
                right = teams[1]
                status = (((comp.get("status") or {}).get("type")) or {}).get("description") or ""
                return AdapterResult(
                    output_text=(
                        f"{left['team']['displayName']} {left.get('score')} - "
                        f"{right['team']['displayName']} {right.get('score')} ({status})."
                    ),
                    success=True,
                    mechanism_used="espn_scoreboard",
                    data=event,
                ).to_payload()
    return AdapterResult(output_text="I couldn't find a matching game on the scoreboard.", success=False, error="no matching game").to_payload()


async def get_standings(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    sport, league = _sport_league(text)
    data = await _get(f"{_BASE}/{sport}/{league}/standings")
    if not data:
        return AdapterResult(output_text="I couldn't find those standings right now.", success=False, error="standings failed").to_payload()
    for child in data.get("children") or []:
        entries = ((child.get("standings") or {}).get("entries")) or []
        if entries:
            entry = entries[0]
            team = (entry.get("team") or {}).get("displayName") or "Unknown team"
            stats = {item.get("name"): item.get("value") for item in entry.get("stats") or []}
            return AdapterResult(
                output_text=f"{team} standings snapshot: {stats.get('wins', '?')}-{stats.get('losses', '?')}.",
                success=True,
                mechanism_used="espn_standings",
                data=entry,
            ).to_payload()
    return AdapterResult(output_text="I couldn't parse the standings response.", success=False, error="empty standings").to_payload()


async def get_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    text = str((payload.get("params") or {}).get("team_or_league") or payload.get("chunk_text") or "")
    sport, league = _sport_league(text)
    data = await _get(f"{_BASE}/{sport}/{league}/scoreboard")
    if not data:
        return AdapterResult(output_text="I couldn't find that schedule right now.", success=False, error="scoreboard failed").to_payload()
    query = text.lower()
    for event in data.get("events") or []:
        name = (event.get("name") or "").lower()
        if any(term in name for term in query.split()):
            return AdapterResult(
                output_text=f"Next listed game: {event.get('name')} on {str(event.get('date') or '')[:10]}.",
                success=True,
                mechanism_used="espn_schedule",
                data=event,
            ).to_payload()
    return AdapterResult(output_text="I couldn't find a matching upcoming game.", success=False, error="no matching event").to_payload()


async def get_player_stats(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("chunk_text") or "").strip()
    return AdapterResult(
        output_text=f"Player stats lookup for '{query}' is not fully structured yet; provider wiring still in progress.",
        success=False,
        error="player stats provider incomplete",
    ).to_payload()
