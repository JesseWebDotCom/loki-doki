"""
Synthesis prompt slot assembly.

Each tier gets its own named slot in the combine prompt. The synthesizer
never sees a giant memory blob — it sees structured, labeled context with
hard char budgets enforced in this module (not in the prompt).

Phase status:
    M2 — `{user_facts}` is now live and assembled from the v2 reader.
    M3 will wire `{social_context}`; M4 wires `{recent_context}` and
    `{relevant_episodes}`; M5 wires `{user_style}`; M6 wires `{recent_mood}`.
    The other slot assemblers stay as placeholders that always return ""
    until their phase ships.

Total worst-case slot budget is 1,470 chars per `docs/MEMORY_DESIGN.md` §4.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Iterable

from v2.orchestrator.memory.reader import (
    FactHit,
    PersonHit,
    read_social_context,
    read_user_facts,
)
from v2.orchestrator.memory.store import V2MemoryStore


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

USER_FACTS_BUDGET: Final[int] = 250
SOCIAL_CONTEXT_BUDGET: Final[int] = 200


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


def render_user_facts(hits: Iterable[FactHit]) -> str:
    """Render Tier 4 fact hits into the `{user_facts}` slot string.

    Format: a comma-separated list of "predicate=value" pairs prefixed
    with the subject when the subject isn't ``self``. The synthesizer
    sees this as labeled, structured context — never a paragraph of
    free text. Truncated to the per-slot budget.
    """
    parts: list[str] = []
    for hit in hits:
        if hit.subject == "self":
            parts.append(f"{hit.predicate}={hit.value}")
        else:
            parts.append(f"{hit.subject} {hit.predicate}={hit.value}")
    rendered = "; ".join(parts)
    return truncate_to_budget("user_facts", rendered)


def assemble_user_facts_slot(
    *,
    store: V2MemoryStore,
    owner_user_id: int,
    query: str,
    top_k: int = 3,
) -> tuple[str, list[FactHit]]:
    """End-to-end slot assembly for Tier 4. Returns (slot_string, hits)."""
    hits = read_user_facts(store, owner_user_id, query, top_k=top_k)
    return render_user_facts(hits), hits


def render_social_context(hits: Iterable[PersonHit]) -> str:
    """Render Tier 5 person hits into the `{social_context}` slot string.

    Format per person: ``{label}={relation_label}`` where label is the
    name when known, ``"my <handle>"`` for provisional rows, or the
    relation noun otherwise. Multiple persons are joined with ``"; "``.
    Truncated to 200 chars at a word boundary per design §4.
    """
    parts: list[str] = []
    for hit in hits:
        if hit.name:
            label = hit.name
        elif hit.handle:
            label = hit.handle
        else:
            label = "person"
        if hit.relations:
            parts.append(f"{label}={'/'.join(hit.relations)}")
        else:
            parts.append(label)
    rendered = "; ".join(parts)
    return truncate_to_budget("social_context", rendered)


def assemble_social_context_slot(
    *,
    store: V2MemoryStore,
    owner_user_id: int,
    query: str,
    top_k: int = 3,
) -> tuple[str, list[PersonHit]]:
    """End-to-end slot assembly for Tier 5. Returns (slot_string, hits)."""
    hits = read_social_context(store, owner_user_id, query, top_k=top_k)
    return render_social_context(hits), hits


def assemble_slots(context: dict) -> dict[str, str]:
    """Return all six prompt slots.

    Pulls the active store + query out of `context` when one of the
    relevant ``need_*`` flags is set. Slots whose tiers haven't shipped
    yet (M4+) return "".
    """
    out = {spec.name: "" for spec in SLOT_SPECS}
    store = context.get("memory_store")
    if not isinstance(store, V2MemoryStore):
        return out
    owner_user_id = int(context.get("owner_user_id") or 0)
    query = str(context.get("memory_query") or context.get("user_input") or "")
    if context.get("need_preference"):
        rendered, _hits = assemble_user_facts_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
        )
        out["user_facts"] = rendered
    if context.get("need_social"):
        rendered, _hits = assemble_social_context_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
        )
        out["social_context"] = rendered
    return out
