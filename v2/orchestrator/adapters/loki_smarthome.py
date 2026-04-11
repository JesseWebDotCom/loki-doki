"""JSON-state SmartHome adapter for the v2 orchestrator.

Wraps the same ``data/smarthome_state.json`` file the legacy
``smarthome_mock`` skill writes to, but exposes the v2 prototype's
``HomeAssistantAdapter`` interface so the device resolver can use it as
a drop-in replacement for the in-memory stub.

The adapter is **read-only**: v2 must not mutate device state. The
existing ``SmartHomeMockSkill`` remains the writer.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from v2.orchestrator.adapters.home_assistant import DeviceMatch, DeviceRecord

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover
    fuzz = None


# Map the legacy ``type`` field to a Home-Assistant-style domain so the
# v2 device resolver does not have to know about smarthome_mock's
# vocabulary.
_TYPE_TO_DOMAIN: dict[str, str] = {
    "light": "light",
    "climate": "climate",
    "lock": "lock",
    "cover": "cover",
    "fan": "fan",
    "media_player": "media_player",
    "switch": "switch",
}


class LokiSmartHomeAdapter:
    """Read-only DeviceRegistry adapter backed by the smarthome_mock JSON file."""

    def __init__(self, state_path: str | Path = "data/smarthome_state.json") -> None:
        self._state_path = Path(state_path)

    # ---- public API mirrors HomeAssistantAdapter ----------------------------

    def all(self) -> tuple[DeviceRecord, ...]:
        return tuple(self._iter_devices())

    def resolve(self, mention: str) -> DeviceMatch | None:
        if not mention or not mention.strip():
            return None
        needle = mention.strip().lower()
        devices = list(self._iter_devices())
        if not devices:
            return None

        exact = [
            device
            for device in devices
            if needle == device.friendly_name.lower()
            or needle in (alias.lower() for alias in device.aliases)
        ]
        if exact:
            return DeviceMatch(
                record=exact[0],
                score=100,
                matched_phrase=needle,
                ambiguous=len(exact) > 1,
                candidates=exact,
            )

        substring = [
            device
            for device in devices
            if needle in device.friendly_name.lower()
            or any(needle in alias.lower() for alias in device.aliases)
        ]
        if substring:
            return DeviceMatch(
                record=substring[0],
                score=85,
                matched_phrase=needle,
                ambiguous=len(substring) > 1,
                candidates=substring,
            )

        if fuzz is None:
            return None

        scored: list[tuple[int, DeviceRecord]] = []
        for device in devices:
            pool = [device.friendly_name.lower(), *(alias.lower() for alias in device.aliases)]
            best = max(fuzz.partial_ratio(needle, candidate) for candidate in pool)
            if best >= 80:
                scored.append((best, device))
        if not scored:
            return None
        scored.sort(key=lambda item: -item[0])
        top_score = scored[0][0]
        top_devices = [device for score, device in scored if score == top_score]
        return DeviceMatch(
            record=top_devices[0],
            score=top_score,
            matched_phrase=needle,
            ambiguous=len(top_devices) > 1,
            candidates=top_devices,
        )

    # ---- internals ----------------------------------------------------------

    def _iter_devices(self) -> Iterable[DeviceRecord]:
        if not self._state_path.exists():
            return
        try:
            raw = json.loads(self._state_path.read_text())
        except (json.JSONDecodeError, OSError):
            return
        if not isinstance(raw, dict):
            return

        for entity_id, payload in raw.items():
            if not isinstance(payload, dict):
                continue
            friendly_name = str(payload.get("name") or entity_id)
            type_ = str(payload.get("type") or "")
            domain = _TYPE_TO_DOMAIN.get(type_, type_ or "device")
            aliases = _aliases_for(entity_id, friendly_name)
            yield DeviceRecord(
                entity_id=f"{domain}.{entity_id}",
                friendly_name=friendly_name,
                domain=domain,
                area=_area_from_entity(entity_id),
                aliases=aliases,
            )


def _aliases_for(entity_id: str, friendly_name: str) -> list[str]:
    aliases = {entity_id.replace("_", " "), friendly_name.lower()}
    # Drop the trailing word ("light", "lock", "fan") to give resolvers
    # a shorter handle (e.g. "kitchen" → "kitchen light").
    parts = friendly_name.lower().split()
    if len(parts) >= 2:
        aliases.add(" ".join(parts[:-1]))
    return sorted(aliases)


def _area_from_entity(entity_id: str) -> str:
    parts = entity_id.split("_")
    if len(parts) >= 2 and parts[0] in {"living", "dining", "master", "guest"}:
        return f"{parts[0]}_{parts[1]}"
    return parts[0] if parts else "unknown"
