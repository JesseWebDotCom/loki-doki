"""Local playback state plus MusicBrainz-backed metadata lookup."""
from __future__ import annotations

import re
from typing import Any

import httpx

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills._store import load_store, save_store

_DEFAULT = {"now_playing": None, "queue": [], "volume": 50}
_API = "https://musicbrainz.org/ws/2/recording/"


def _store() -> dict[str, Any]:
    return load_store("music", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("music", payload)


def play_music(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").strip()
    store = _store()
    store["now_playing"] = {"title": query, "state": "playing"}
    _save(store)
    return AdapterResult(output_text=f"Playing {query}.", success=True, mechanism_used="local_player", data=store["now_playing"]).to_payload()


def control_playback(payload: dict[str, Any]) -> dict[str, Any]:
    action = str((payload.get("params") or {}).get("action") or payload.get("chunk_text") or "").lower()
    store = _store()
    current = store.get("now_playing") or {"title": "your audio", "state": "stopped"}
    if "pause" in action:
        current["state"] = "paused"
    elif "skip" in action:
        current["state"] = "skipped"
    elif "repeat" in action:
        current["state"] = "repeating"
    else:
        current["state"] = action or "updated"
    store["now_playing"] = current
    _save(store)
    return AdapterResult(output_text=f"{current['title']} is now {current['state']}.", success=True, mechanism_used="local_player", data=current).to_payload()


def get_now_playing(payload: dict[str, Any]) -> dict[str, Any]:
    current = _store().get("now_playing")
    if not current:
        return AdapterResult(output_text="Nothing is playing right now.", success=True).to_payload()
    return AdapterResult(output_text=f"Now playing: {current['title']} ({current['state']}).", success=True, data=current).to_payload()


def set_volume(payload: dict[str, Any]) -> dict[str, Any]:
    text = str((payload.get("params") or {}).get("level") or payload.get("chunk_text") or "")
    match = re.search(r"(\d{1,3})", text)
    if not match:
        return AdapterResult(output_text="Tell me the volume level as a percentage.", success=False, error="missing volume").to_payload()
    level = max(0, min(100, int(match.group(1))))
    store = _store()
    store["volume"] = level
    _save(store)
    return AdapterResult(output_text=f"Volume set to {level}%.", success=True, mechanism_used="local_player", data={"volume": level}).to_payload()


async def lookup_track(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").strip()
    if not query:
        return AdapterResult(output_text="Tell me which song or artist to look up.", success=False, error="missing query").to_payload()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                _API,
                params={"query": query, "fmt": "json", "limit": 1},
                headers={"User-Agent": "LokiDoki/0.2 (music metadata)"},
            )
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't look up that track right now.", success=False, error=str(exc)).to_payload()
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't look up that track right now.", success=False, error=f"http {response.status_code}").to_payload()
    data = response.json()
    recordings = data.get("recordings") or []
    if not recordings:
        return AdapterResult(output_text="I couldn't find that track.", success=False, error="no results").to_payload()
    first = recordings[0]
    title = first.get("title") or query
    artists = ", ".join(credit.get("name") or "" for credit in first.get("artist-credit", [])) or "Unknown artist"
    release = ""
    if first.get("releases"):
        release = first["releases"][0].get("title") or ""
    text = f"{title} is by {artists}." + (f" Release: {release}." if release else "")
    return AdapterResult(output_text=text, success=True, mechanism_used="musicbrainz", data=first).to_payload()
