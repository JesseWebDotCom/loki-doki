"""Typed model + enum for decomposer output."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

CapabilityNeed = Literal[
    "encyclopedic",
    "medical",
    "howto",
    "country_facts",
    "education",
    "technical_reference",
    "geographic",
    "weather",
    "current_media",
    "people_lookup",
    "youtube",
    "web_search",
    "calendar",
    "timer_reminder",
    "navigation",
    "conversion",
    "messaging",
    "music_control",
    "device_control",
    "news",
    "none",
]

CAPABILITY_NEEDS: tuple[str, ...] = (
    "encyclopedic",
    "medical",
    "howto",
    "country_facts",
    "education",
    "technical_reference",
    "geographic",
    "weather",
    "current_media",
    "people_lookup",
    "youtube",
    "web_search",
    "calendar",
    "timer_reminder",
    "navigation",
    "conversion",
    "messaging",
    "music_control",
    "device_control",
    "news",
    "none",
)


@dataclass(slots=True)
class RouteDecomposition:
    """Routing-only decomposer output.

    ``capability_need`` is the primary routing signal; the router uses
    it to boost the matching capability's cosine score. ``archive_hint``
    narrows ZIM search to a specific source family when present
    (e.g. ``"medlineplus"`` for drug questions inside the medical
    capability). ``source`` records how the value was obtained so
    observability traces show whether the LLM actually ran.
    """

    capability_need: str = "none"
    archive_hint: str = ""
    resolved_query: str = ""
    source: str = "fallback"  # "llm" | "timeout" | "error" | "disabled" | "fallback"
    latency_ms: float = 0.0

    def is_authoritative(self) -> bool:
        """True when the decomposer produced a real LLM-backed signal."""
        return self.source == "llm" and self.capability_need != "none"
