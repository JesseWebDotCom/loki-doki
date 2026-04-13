"""Device resolver for the v2 prototype.

Maps "the kitchen light" / "the fan" / "the thermostat" to a concrete
Home Assistant entity id via :class:`HomeAssistantAdapter`. Ambiguous
mentions surface as ``unresolved`` instead of being silently guessed.
"""
from __future__ import annotations

from typing import Protocol

from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch


class DeviceAdapter(Protocol):
    """Structural typing for device adapters (HomeAssistantAdapter / LokiSmartHomeAdapter)."""

    def resolve(self, mention: str) -> object | None: ...

DEVICE_CAPABILITIES = {
    "control_device",
    "get_device_state",
    "list_devices",
}


def resolve_device(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    adapter: DeviceAdapter,
) -> ResolutionResult | None:
    if route.capability not in DEVICE_CAPABILITIES:
        return None

    candidates = _device_mentions(extraction, chunk.text)
    if not candidates:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="",
            source="missing_device",
            confidence=route.confidence,
            unresolved=["device:missing"],
            notes=["no device noun phrase in chunk"],
        )

    for mention in candidates:
        match = adapter.resolve(mention)
        if match is None:
            continue
        if match.ambiguous and len({device.entity_id for device in match.candidates}) > 1:
            return ResolutionResult(
                chunk_index=chunk.index,
                resolved_target=match.record.friendly_name,
                source="ambiguous_device",
                confidence=round(match.score / 100, 3),
                candidate_values=[device.friendly_name for device in match.candidates],
                unresolved=[f"device_ambiguous:{mention}"],
                params={
                    "entity_id": match.record.entity_id,
                    "domain": match.record.domain,
                    "matched_phrase": match.matched_phrase,
                },
                notes=[f"multiple devices match {mention}"],
            )
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target=match.record.friendly_name,
            source="home_assistant",
            confidence=round(match.score / 100, 3),
            context_value=match.record.entity_id,
            params={
                "entity_id": match.record.entity_id,
                "domain": match.record.domain,
                "area": match.record.area,
                "matched_phrase": match.matched_phrase,
            },
        )

    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=candidates[0],
        source="unresolved_device",
        confidence=route.confidence,
        unresolved=[f"device:{candidate}" for candidate in candidates],
        notes=[f"could not resolve {candidates[0]}"],
    )


def _device_mentions(extraction: ChunkExtraction, raw_text: str) -> list[str]:
    mentions: list[str] = []
    for noun_phrase in extraction.subject_candidates:
        cleaned = noun_phrase.strip()
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in {"i", "you", "we", "they", "it", "this", "that"}:
            continue
        mentions.append(cleaned)
    if not mentions and raw_text:
        mentions.append(raw_text.strip())
    return mentions
