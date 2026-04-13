"""Presence detection and scene control for smarthome.

Mechanism chain for detect_presence:
  1. ``ha_sensor``    — placeholder for real HA binary_sensor lookup.
  2. ``local_state``  — read from presence.json (canonical store).
  3. ``graceful_failure`` — polite "I don't see anyone" response.

Scenes compose multiple local state writes against the mock backend.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms
from lokidoki.orchestrator.skills._store import load_store, save_store
from lokidoki.orchestrator.skills.smarthome import _normalize, _format_control_success

_SKILL = SmartHomeMockSkill()

_PRESENCE_DEFAULT: dict[str, Any] = {
    "rooms": {
        "living room": [],
        "kitchen": [],
        "bedroom": [],
        "office": [],
        "garage": [],
    }
}


def _presence_store() -> dict[str, Any]:
    return load_store("presence", _PRESENCE_DEFAULT)


def _save_presence(payload: dict[str, Any]) -> None:
    save_store("presence", payload)


def set_presence(room: str, who: str | list[str]) -> None:
    """Overwrite the persistent presence store for one room."""
    store = _presence_store()
    rooms = store.setdefault("rooms", {})
    if isinstance(who, str):
        rooms[room.lower().strip()] = [who] if who and who != "no one" else []
    else:
        rooms[room.lower().strip()] = list(who)
    _save_presence(store)


def clear_presence(room: str | None = None) -> None:
    """Reset the persistent presence store."""
    store = _presence_store()
    rooms = store.setdefault("rooms", {})
    if room is None:
        for key in list(rooms.keys()):
            rooms[key] = []
    else:
        rooms[room.lower().strip()] = []
    _save_presence(store)


def _parse_presence_room(chunk_text: str) -> str:
    lower = _normalize(chunk_text)
    for marker in (" in the ", " in "):
        if marker in lower:
            tail = lower.split(marker, 1)[1].strip()
            from lokidoki.orchestrator.skills.smarthome import _strip_leading_articles
            tail = _strip_leading_articles(tail)
            if tail:
                return tail
    return ""


def _ha_sensor_lookup(room: str) -> list[str] | None:
    """Stub for future real Home Assistant binary_sensor lookup."""
    return None


async def detect_presence(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    room = (params.get("room") or _parse_presence_room(chunk_text) or "").lower().strip()
    if not room:
        return AdapterResult(
            output_text="Which room would you like me to check?",
            success=False, mechanism_used="local_state", error="no room",
        ).to_payload()

    occupants: list[str] | None = _ha_sensor_lookup(room)
    mechanism = "ha_sensor"
    if occupants is None:
        rooms = _presence_store().get("rooms", {})
        raw = rooms.get(room)
        if raw is None:
            return AdapterResult(
                output_text=f"I don't have a presence sensor for the {room}.",
                success=False, mechanism_used="local_state", error="unknown room",
            ).to_payload()
        if isinstance(raw, str):
            occupants = [raw] if raw and raw != "no one" else []
        else:
            occupants = [str(item) for item in raw if item]
        mechanism = "local_state"

    text = _format_occupants(room, occupants)
    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used=mechanism,
        data={"room": room, "occupants": occupants},
    ).to_payload()


def _format_occupants(room: str, occupants: list[str]) -> str:
    """Return a human-readable sentence describing room occupancy."""
    if not occupants:
        return f"I don't see anyone in the {room} right now."
    if len(occupants) == 1:
        return f"{occupants[0]} is in the {room}."
    head = ", ".join(occupants[:-1])
    return f"{head} and {occupants[-1]} are in the {room}."


_SCENES: dict[str, list[tuple[str, str]]] = {
    "movie mode": [("living room light", "off"), ("tv", "on")],
    "goodnight": [("living room light", "off"), ("garage door", "closed"), ("front door", "lock")],
    "party time": [("living room light", "on"), ("tv", "on")],
}


async def set_scene(payload: dict[str, Any]) -> dict[str, Any]:
    scene_name = str(
        (payload.get("params") or {}).get("scene_name")
        or payload.get("chunk_text") or ""
    ).lower().strip()
    for name, actions in _SCENES.items():
        if name in scene_name:
            for device, action in actions:
                await run_mechanisms(
                    _SKILL,
                    [("local_state", {"device": device, "action": action})],
                    on_success=_format_control_success,
                    on_all_failed=f"I couldn't apply {name}.",
                )
            return AdapterResult(
                output_text=f"Activated scene '{name}'.",
                success=True, mechanism_used="local_scene",
                data={"scene": name, "actions": actions},
            ).to_payload()
    return AdapterResult(
        output_text="I couldn't find that scene.",
        success=False, error="unknown scene",
    ).to_payload()
