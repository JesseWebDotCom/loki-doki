"""v2 smarthome adapters — wrap lokidoki.skills.smarthome_mock.

The v1 SmartHomeMockSkill is a JSON-backed mock controller that handles
lights, locks, doors, and a thermostat. We expose four v2 capabilities on
top of it:

  - ``control_device``     — imperative on/off/lock/open/close/dim
  - ``get_device_state``   — read current open/closed/on/off/locked state
  - ``get_indoor_temperature`` — read the thermostat's current temperature
  - ``detect_presence``    — best-effort presence guess from device state

Presence is the only capability the v1 mock doesn't natively support,
so the adapter overlays an in-memory ``_PRESENCE`` table indexed by room.
A future replacement (real HA presence sensor) only needs to swap that
helper out.

Scenes are also implemented at the v2 layer by composing multiple local
state writes against the existing mock device backend.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

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
# The v1 mock has no presence sensors, so we keep a small in-memory
# overlay table the test suite (or a future real HA integration) can
# poke at. The default seed reflects "no one home" so the response is
# deterministic. A real implementation would call into a Home Assistant
# `binary_sensor.<room>_occupancy` entity instead of this dict.

_PRESENCE: dict[str, str] = {
    "living room": "no one",
    "kitchen": "no one",
    "bedroom": "no one",
    "office": "no one",
    "garage": "no one",
}


def set_presence(room: str, who: str) -> None:
    """Test helper — overwrite the in-memory presence table for one room."""
    _PRESENCE[room.lower().strip()] = who


def _parse_presence_room(chunk_text: str) -> str:
    lower = _normalize(chunk_text)
    for marker in (" in the ", " in "):
        if marker in lower:
            tail = lower.split(marker, 1)[1].strip()
            tail = _strip_leading_articles(tail)
            if tail:
                return tail
    return ""


async def detect_presence(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    room = _parse_presence_room(chunk_text)
    if not room:
        return AdapterResult(
            output_text="Which room would you like me to check?",
            success=False,
            error="no room",
        ).to_payload()
    who = _PRESENCE.get(room, "no one")
    if who == "no one":
        return AdapterResult(
            output_text=f"I don't see anyone in the {room} right now.",
            success=True,
            mechanism_used="presence_overlay",
            data={"room": room, "occupants": []},
        ).to_payload()
    return AdapterResult(
        output_text=f"{who} is in the {room}.",
        success=True,
        mechanism_used="presence_overlay",
        data={"room": room, "occupants": [who]},
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
