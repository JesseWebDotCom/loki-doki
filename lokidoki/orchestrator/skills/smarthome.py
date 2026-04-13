"""smarthome adapters — wrap lokidoki.skills.smarthome_mock.

The v1 SmartHomeMockSkill is a JSON-backed mock controller that handles
lights, locks, doors, and a thermostat. We expose four capabilities on
top of it:

  - ``control_device``     — imperative on/off/lock/open/close/dim
  - ``get_device_state``   — read current open/closed/on/off/locked state
  - ``get_indoor_temperature`` — read the thermostat's current temperature
  - ``detect_presence``    — best-effort presence guess from device state

Presence is the only capability the v1 mock doesn't natively support,
so the adapter overlays an in-memory ``_PRESENCE`` table indexed by room.
A future replacement (real HA presence sensor) only needs to swap that
helper out.

Scenes are also implemented at the adapter layer by composing multiple local
state writes against the existing mock device backend.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms
from lokidoki.orchestrator.skills._store import load_store, save_store

_SKILL = SmartHomeMockSkill()


# ---- shared helpers --------------------------------------------------------


def _normalize(text: str) -> str:
    return re.sub(r"[?!.,]+$", "", str(text or "").lower().strip())


def _strip_leading_articles(text: str) -> str:
    out = text
    for prefix in ("the ", "a ", "an ", "my "):
        if out.startswith(prefix):
            out = out[len(prefix):]
    return out


# ---- control_device --------------------------------------------------------

_CONTROL_VERBS = {
    "turn on": "on",
    "turn off": "off",
    "switch on": "on",
    "switch off": "off",
    "toggle": "toggle",
    "lock": "lock",
    "unlock": "unlock",
    "open": "open",
    "close": "close",
    "shut": "close",
    "dim": "brightness:30",
}


def _parse_control_intent(chunk_text: str) -> tuple[str, str] | None:
    """Return ``(device_query, action)`` or ``None`` if no verb matches."""
    lower = _normalize(chunk_text)
    for verb, action in _CONTROL_VERBS.items():
        if lower.startswith(verb + " "):
            tail = lower[len(verb) + 1:].strip()
            tail = _strip_leading_articles(tail)
            if tail:
                return tail, action
    return None


def _format_control_success(result, method: str) -> str:
    data = result.data or {}
    name = data.get("name") or data.get("device_id") or "device"
    state = data.get("state") or data.get("action") or "updated"
    return f"{name} is now {state}."


async def control_device(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    parsed = _parse_control_intent(chunk_text)
    if parsed is None:
        return AdapterResult(
            output_text="I'm not sure which device you want me to change.",
            success=False,
            error="no control verb",
        ).to_payload()
    device_query, action = parsed
    attempts = [
        ("local_state", {"device": device_query, "action": action}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_control_success,
        on_all_failed=f"I couldn't find a device matching '{device_query}'.",
    )
    return result.to_payload()


# ---- get_device_state ------------------------------------------------------

_STATE_QUERY_VERBS = (
    "is the ",
    "is my ",
    "are the ",
    "are my ",
    "did i close ",
    "did i open ",
    "did i lock ",
    "did i unlock ",
    "did i turn on ",
    "did i turn off ",
)


def _parse_state_query(chunk_text: str) -> str | None:
    lower = _normalize(chunk_text)
    for verb in _STATE_QUERY_VERBS:
        if lower.startswith(verb):
            tail = lower[len(verb):].strip()
            tail = _strip_leading_articles(tail)
            for trailer in (" on", " off", " locked", " unlocked", " open", " closed", " running"):
                if tail.endswith(trailer):
                    tail = tail[: -len(trailer)].strip()
                    break
            if tail:
                return tail
    return None


def _format_state_success(result, method: str) -> str:
    data = result.data or {}
    name = data.get("name") or data.get("device_id") or "the device"
    state = data.get("state") or "in an unknown state"
    extras: list[str] = []
    if data.get("brightness") is not None and data.get("type") == "light":
        extras.append(f"brightness {data['brightness']}%")
    if data.get("temperature") is not None and data.get("type") == "climate":
        extras.append(f"set to {data['temperature']}°C")
    suffix = f" ({', '.join(extras)})" if extras else ""
    return f"{name} is currently {state}{suffix}."


async def get_device_state(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    device_query = _parse_state_query(chunk_text) or _strip_leading_articles(_normalize(chunk_text))
    if not device_query:
        return AdapterResult(
            output_text="Which device's state would you like me to check?",
            success=False,
            error="no device",
        ).to_payload()
    attempts = [
        ("local_state", {"device": device_query, "action": "status"}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_state_success,
        on_all_failed=f"I couldn't find a device matching '{device_query}'.",
    )
    return result.to_payload()


# ---- get_indoor_temperature ------------------------------------------------


def _format_thermostat_success(result, method: str) -> str:
    data = result.data or {}
    temp_c = data.get("temperature")
    if temp_c is None:
        return "The thermostat doesn't currently report a temperature."
    try:
        temp_c_float = float(temp_c)
        temp_f = round(temp_c_float * 9 / 5 + 32)
        return f"Indoor temperature is currently {temp_c_float}°C ({temp_f}°F)."
    except (TypeError, ValueError):
        return f"Indoor temperature is currently {temp_c}°."


async def get_indoor_temperature(payload: dict[str, Any]) -> dict[str, Any]:
    attempts = [
        ("local_state", {"device": "thermostat", "action": "status"}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_thermostat_success,
        on_all_failed="I couldn't read the indoor thermostat right now.",
    )
    return result.to_payload()


# ---- detect_presence -------------------------------------------------------
#
# Mechanism chain (mirrors the v1 ``BaseSkill.execute_mechanism`` pattern):
#
#   1. ``local_state``  — read from ``lokidoki/orchestrator/data/presence.json`` so the test
#      suite, the dev tools panel, and a future real HA bridge can all
#      write to one canonical store.
#   2. ``ha_sensor``    — placeholder for a real Home Assistant
#      ``binary_sensor.<room>_occupancy`` lookup. Today this is a no-op
#      that returns ``None``; the chain falls through to the JSON store
#      which is the source of truth.
#   3. ``graceful_failure`` — return a polite "I don't see anyone"
#      sentence with ``success=True`` so the combiner can deliver it
#      directly to the user.

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
    """Public helper — overwrite the persistent presence store for one room.

    Used by tests, the dev tools panel, and any external bridge that
    wants to seed the canonical presence state.
    """
    store = _presence_store()
    rooms = store.setdefault("rooms", {})
    if isinstance(who, str):
        rooms[room.lower().strip()] = [who] if who and who != "no one" else []
    else:
        rooms[room.lower().strip()] = list(who)
    _save_presence(store)


def clear_presence(room: str | None = None) -> None:
    """Reset the persistent presence store. ``room=None`` clears every room."""
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
            tail = _strip_leading_articles(tail)
            if tail:
                return tail
    return ""


def _ha_sensor_lookup(room: str) -> list[str] | None:
    """Stub for the future real Home Assistant ``binary_sensor`` lookup.

    Returns ``None`` today so the mechanism chain falls through to the
    persistent JSON store. A real implementation would call
    ``hass.states.get(f"binary_sensor.{room}_occupancy")`` and translate
    its ``on/off`` state into an occupant list.
    """
    return None


async def detect_presence(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    room = (params.get("room") or _parse_presence_room(chunk_text) or "").lower().strip()
    if not room:
        return AdapterResult(
            output_text="Which room would you like me to check?",
            success=False,
            mechanism_used="local_state",
            error="no room",
        ).to_payload()

    occupants: list[str] | None = _ha_sensor_lookup(room)
    mechanism = "ha_sensor"
    if occupants is None:
        rooms = _presence_store().get("rooms", {})
        raw = rooms.get(room)
        if raw is None:
            return AdapterResult(
                output_text=f"I don't have a presence sensor for the {room}.",
                success=False,
                mechanism_used="local_state",
                error="unknown room",
            ).to_payload()
        if isinstance(raw, str):
            occupants = [raw] if raw and raw != "no one" else []
        else:
            occupants = [str(item) for item in raw if item]
        mechanism = "local_state"

    if not occupants:
        return AdapterResult(
            output_text=f"I don't see anyone in the {room} right now.",
            success=True,
            mechanism_used=mechanism,
            data={"room": room, "occupants": []},
        ).to_payload()
    if len(occupants) == 1:
        text = f"{occupants[0]} is in the {room}."
    else:
        head = ", ".join(occupants[:-1])
        text = f"{head} and {occupants[-1]} are in the {room}."
    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used=mechanism,
        data={"room": room, "occupants": occupants},
    ).to_payload()


_SCENES: dict[str, list[tuple[str, str]]] = {
    "movie mode": [("living room light", "off"), ("tv", "on")],
    "goodnight": [("living room light", "off"), ("garage door", "closed"), ("front door", "lock")],
    "party time": [("living room light", "on"), ("tv", "on")],
}


async def set_scene(payload: dict[str, Any]) -> dict[str, Any]:
    scene_name = str((payload.get("params") or {}).get("scene_name") or payload.get("chunk_text") or "").lower().strip()
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
                success=True,
                mechanism_used="local_scene",
                data={"scene": name, "actions": actions},
            ).to_payload()
    return AdapterResult(output_text="I couldn't find that scene.", success=False, error="unknown scene").to_payload()
