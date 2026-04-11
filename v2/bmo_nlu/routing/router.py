"""Deterministic hardcoded router for the v2 prototype."""
from __future__ import annotations

from v2.bmo_nlu.core.types import RequestChunk, RouteMatch


def route_chunk(chunk: RequestChunk) -> RouteMatch:
    """Map a chunk to a prototype capability via simple phrase rules."""
    lower = chunk.text.lower().strip()
    capability = "direct_chat"
    confidence = 0.55

    if lower in {"hello", "hi", "hey", "hello there", "hi there"}:
        capability = "greeting_response"
        confidence = 0.99
    elif lower.startswith("how do you spell ") or lower.startswith("spell "):
        capability = "spell_word"
        confidence = 0.99
    elif lower in {"what time is it", "what's the time"}:
        capability = "get_current_time"
        confidence = 0.99
    elif lower in {"thanks", "thank you"}:
        capability = "acknowledgment_response"
        confidence = 0.99

    return RouteMatch(chunk_index=chunk.index, capability=capability, confidence=confidence)
