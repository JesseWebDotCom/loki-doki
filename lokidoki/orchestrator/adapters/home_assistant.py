"""Home Assistant adapter (in-memory stub) for the pipeline.

Mirrors the shape of a real Home Assistant entity registry: each device
exposes ``entity_id``, ``friendly_name``, an ``area``, and a flat list
of aliases. The device resolver uses this to map "the kitchen light"
or "living room fan" to a concrete entity id.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover
    fuzz = None


@dataclass(slots=True)
class DeviceRecord:
    entity_id: str
    friendly_name: str
    domain: str  # light | switch | climate | media_player | fan ...
    area: str
    aliases: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DeviceMatch:
    record: DeviceRecord
    score: int
    matched_phrase: str
    ambiguous: bool = False
    candidates: list[DeviceRecord] = field(default_factory=list)


_DEFAULT_DEVICES: tuple[DeviceRecord, ...] = (
    DeviceRecord(
        entity_id="light.kitchen_main",
        friendly_name="Kitchen Light",
        domain="light",
        area="kitchen",
        aliases=["kitchen light", "kitchen lamp", "kitchen lights"],
    ),
    DeviceRecord(
        entity_id="light.living_room_main",
        friendly_name="Living Room Light",
        domain="light",
        area="living_room",
        aliases=["living room light", "living room lamp", "living room lights"],
    ),
    DeviceRecord(
        entity_id="fan.living_room_ceiling",
        friendly_name="Living Room Fan",
        domain="fan",
        area="living_room",
        aliases=["living room fan", "ceiling fan", "the fan"],
    ),
    DeviceRecord(
        entity_id="climate.thermostat",
        friendly_name="Thermostat",
        domain="climate",
        area="house",
        aliases=["thermostat", "the heat", "the ac", "ac"],
    ),
    DeviceRecord(
        entity_id="media_player.living_room_tv",
        friendly_name="Living Room TV",
        domain="media_player",
        area="living_room",
        aliases=["tv", "television", "the tv", "living room tv"],
    ),
)


def _ha_exact_match(needle: str, devices: tuple[DeviceRecord, ...]) -> list[DeviceRecord]:
    return [
        device
        for device in devices
        if needle == device.friendly_name.lower()
        or needle in (alias.lower() for alias in device.aliases)
    ]


def _ha_substring_match(needle: str, devices: tuple[DeviceRecord, ...]) -> list[DeviceRecord]:
    return [
        device
        for device in devices
        if needle in device.friendly_name.lower()
        or any(needle in alias.lower() for alias in device.aliases)
    ]


def _ha_fuzzy_match(
    needle: str,
    devices: tuple[DeviceRecord, ...],
) -> DeviceMatch | None:
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


def _ha_match_device(
    needle: str,
    devices: tuple[DeviceRecord, ...],
) -> DeviceMatch | None:
    """Exact → substring → fuzzy match across a HA device registry."""
    exact = _ha_exact_match(needle, devices)
    if exact:
        return DeviceMatch(
            record=exact[0],
            score=100,
            matched_phrase=needle,
            ambiguous=len(exact) > 1,
            candidates=exact,
        )
    substring = _ha_substring_match(needle, devices)
    if substring:
        return DeviceMatch(
            record=substring[0],
            score=85,
            matched_phrase=needle,
            ambiguous=len(substring) > 1,
            candidates=substring,
        )
    return _ha_fuzzy_match(needle, devices)


class HomeAssistantAdapter:
    """Alias + fuzzy lookup over a curated device registry."""

    def __init__(self, devices: Iterable[DeviceRecord] | None = None) -> None:
        self._devices: tuple[DeviceRecord, ...] = tuple(devices or _DEFAULT_DEVICES)

    def all(self) -> tuple[DeviceRecord, ...]:
        return self._devices

    def resolve(self, mention: str) -> DeviceMatch | None:
        if not mention or not mention.strip():
            return None
        needle = mention.strip().lower()
        return _ha_match_device(needle, self._devices)
