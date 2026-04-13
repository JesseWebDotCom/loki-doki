"""Sports adapters backed by ESPN public JSON endpoints."""
from __future__ import annotations

import re
from typing import Any

import httpx

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.execution.errors import ErrorKind

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
                    source_url=f"https://www.espn.com/{sport}/{league}/scoreboard",
                    source_title=f"ESPN — {league.upper()} Scoreboard",
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
                source_url=f"https://www.espn.com/{sport}/{league}/standings",
                source_title=f"ESPN — {league.upper()} Standings",
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
                source_url=f"https://www.espn.com/{sport}/{league}/schedule",
                source_title=f"ESPN — {league.upper()} Schedule",
            ).to_payload()
    return AdapterResult(output_text="I couldn't find a matching upcoming game.", success=False, error="no matching event").to_payload()


async def get_player_stats(payload: dict[str, Any]) -> dict[str, Any]:
    """Look up player stats via ESPN athlete search + statistics endpoint."""
    params = payload.get("params") or {}
    player = str(params.get("player") or payload.get("chunk_text") or "").strip()
    if not player:
        return AdapterResult(
            output_text="Which player would you like stats for?",
            success=False,
            error="missing player",
        ).to_payload()
    sport, league = _sport_league(player)
    # ESPN athlete search endpoint
    search_url = f"{_BASE}/{sport}/{league}/athletes"
    athletes = await _get(search_url)
    # Try the site search API as fallback
    if not athletes or not athletes.get("athletes"):
        search_url2 = (
            f"https://site.api.espn.com/apis/common/v3/search"
            f"?query={player}&limit=3&type=player"
        )
        search_data = await _get(search_url2)
        if search_data and search_data.get("items"):
            item = search_data["items"][0]
            name = item.get("displayName") or player
            description = item.get("description") or ""
            return AdapterResult(
                output_text=f"{name}: {description}" if description else f"Found {name} but no detailed stats available.",
                success=bool(description),
                mechanism_used="espn_search",
                data=item,
                source_url=f"https://www.espn.com/search/_/q/{player.replace(' ', '%20')}",
                source_title=f"ESPN — {name}",
            ).to_payload()
        return AdapterResult(
            output_text=f"I couldn't find stats for '{player}' on ESPN.",
            success=False,
            error="player not found",
        ).to_payload()
    # Search through athlete roster
    query_lower = player.lower()
    for athlete in athletes.get("athletes") or []:
        name = (athlete.get("fullName") or athlete.get("displayName") or "").lower()
        if query_lower in name or any(t in name for t in query_lower.split()):
            display = athlete.get("displayName") or athlete.get("fullName") or player
            position = athlete.get("position", {}).get("abbreviation") or ""
            team = ((athlete.get("team") or {}).get("displayName")) or ""
            stats_summary = []
            for stat_cat in athlete.get("statistics") or []:
                for split in stat_cat.get("splits") or []:
                    for stat in split.get("stats") or []:
                        if stat.get("value"):
                            stats_summary.append(f"{stat.get('name', '?')}: {stat['value']}")
            parts = [display]
            if position:
                parts.append(f"({position})")
            if team:
                parts.append(f"— {team}")
            header = " ".join(parts)
            if stats_summary:
                return AdapterResult(
                    output_text=f"{header}. Stats: {', '.join(stats_summary[:6])}.",
                    success=True,
                    mechanism_used="espn_athletes",
                    data=athlete,
                    source_url=f"https://www.espn.com/{sport}/{league}/player/_/id/{athlete.get('id', '')}",
                    source_title=f"ESPN — {display}",
                ).to_payload()
            return AdapterResult(
                output_text=f"{header}. Season stats not yet available.",
                success=True,
                mechanism_used="espn_athletes",
                data=athlete,
                source_url=f"https://www.espn.com/{sport}/{league}/player/_/id/{athlete.get('id', '')}",
                source_title=f"ESPN — {display}",
            ).to_payload()
    return AdapterResult(
        output_text=f"I couldn't find stats for '{player}' on ESPN.",
        success=False,
        error="player not found",
    ).to_payload()
