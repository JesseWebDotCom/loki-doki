"""
Synthesis prompt slot assembly.

Each tier gets its own named slot in the combine prompt. The synthesizer
never sees a giant memory blob — it sees structured, labeled context with
hard char budgets enforced in this module (not in the prompt).

Phase status: M0 — slot constants and a no-op assembler. M2 wires the first
real slot (`{user_facts}`); M3 wires `{social_context}`; M4 wires
`{recent_context}` and `{relevant_episodes}`; M5 wires `{user_style}`;
M6 wires `{recent_mood}`.

Total worst-case slot budget is 1,470 chars per `docs/MEMORY_DESIGN.md` §4.
"""
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


# Slot table mirrors `docs/MEMORY_DESIGN.md` §4 (Synthesis prompt slots).
SLOT_SPECS: Final[tuple[SlotSpec, ...]] = (
    SlotSpec("user_style", tier=7, char_budget=200, always_present=True, landing_phase="M5"),
    SlotSpec("recent_mood", tier=6, char_budget=120, always_present=True, landing_phase="M6"),
    SlotSpec("recent_context", tier=2, char_budget=300, always_present=False, landing_phase="M4"),
    SlotSpec("relevant_episodes", tier=3, char_budget=400, always_present=False, landing_phase="M4"),
    SlotSpec("user_facts", tier=4, char_budget=250, always_present=False, landing_phase="M2"),
    SlotSpec("social_context", tier=5, char_budget=200, always_present=False, landing_phase="M3"),
)

WORST_CASE_TOTAL_BUDGET: Final[int] = sum(spec.char_budget for spec in SLOT_SPECS)
assert WORST_CASE_TOTAL_BUDGET == 1470, "Slot budget total drifted from §4"


def assemble_slots(context: dict) -> dict[str, str]:  # noqa: ARG001
    """Return all six prompt slots; M0 stub returns empty strings."""
    return {spec.name: "" for spec in SLOT_SPECS}


def truncate_to_budget(slot_name: str, value: str) -> str:
    """Hard-truncate a slot value to its budget. Real ranking lands in M2."""
    spec = next((s for s in SLOT_SPECS if s.name == slot_name), None)
    if spec is None:
        raise KeyError(f"unknown slot: {slot_name}")
    if len(value) <= spec.char_budget:
        return value
    return value[: spec.char_budget]
