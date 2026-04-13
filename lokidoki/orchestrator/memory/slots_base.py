"""Base types and utilities for memory slots to prevent circular imports."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True)
class SlotSpec:
    name: str
    tier: int
    char_budget: int
    always_present: bool
    landing_phase: str


# Slot table mirrors `docs/DESIGN.md` §6.4 (Synthesis prompt slots).
SLOT_SPECS: Final[tuple[SlotSpec, ...]] = (
    SlotSpec("user_style", tier=7, char_budget=200, always_present=True, landing_phase="M5"),
    SlotSpec("recent_mood", tier=6, char_budget=120, always_present=True, landing_phase="M6"),
    SlotSpec("recent_context", tier=2, char_budget=300, always_present=False, landing_phase="M4"),
    SlotSpec("relevant_episodes", tier=3, char_budget=400, always_present=False, landing_phase="M4"),
    SlotSpec("user_facts", tier=4, char_budget=250, always_present=False, landing_phase="M2"),
    SlotSpec("social_context", tier=5, char_budget=200, always_present=False, landing_phase="M3"),
)

# Closed enum of Tier 7a style descriptors. Each key maps to a short
# label the synthesizer can interpret without explanation. Only these
# keys are allowed in `user_profile.style`; everything else is telemetry.
STYLE_DESCRIPTORS: Final[tuple[str, ...]] = (
    "tone",               # e.g. "casual", "formal", "playful"
    "verbosity",          # e.g. "concise", "detailed"
    "formality",          # e.g. "informal", "professional"
    "name_form",          # e.g. "first_name", "full_name", "nickname"
    "preferred_modality", # e.g. "text", "voice"
    "units",              # e.g. "metric", "imperial"
)


def truncate_to_budget(slot_name: str, value: str) -> str:
    """Hard-truncate a slot value to its budget."""
    spec = next((s for s in SLOT_SPECS if s.name == slot_name), None)
    if spec is None:
        raise KeyError(f"unknown slot: {slot_name}")
    if len(value) <= spec.char_budget:
        return value
    # Truncate at a word boundary if one exists in the last 20 chars,
    # otherwise hard-truncate. The synthesizer ignores trailing
    # whitespace so a clipped slot still renders cleanly.
    cutoff = spec.char_budget
    window = value[: cutoff]
    space_at = window.rfind(" ")
    if space_at >= cutoff - 20:
        return window[:space_at]
    return window
