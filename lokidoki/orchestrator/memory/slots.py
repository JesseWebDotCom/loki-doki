"""
Synthesis prompt slot assembly.

Each tier gets its own named slot in the combine prompt. The synthesizer
never sees a giant memory blob — it sees structured, labeled context with
hard char budgets enforced in this module (not in the prompt).

Phase status:
    M2 — `{user_facts}` is now live and assembled from the reader.
    M3 will wire `{social_context}`; M4 wires `{recent_context}` and
    `{relevant_episodes}`; M5 wires `{user_style}`; M6 wires `{recent_mood}`.
    The other slot assemblers stay as placeholders that always return ""
    until their phase ships.

Total worst-case slot budget is 1,470 chars per `docs/MEMORY_DESIGN.md` §4.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from lokidoki.orchestrator.memory.reader import (
    EpisodeHit,
    FactHit,
    PersonHit,
    SessionContext,
    read_episodes,
    read_recent_context,
    read_social_context,
    read_user_facts,
)
from lokidoki.orchestrator.memory.store import MemoryStore


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

RECENT_MOOD_BUDGET: Final[int] = 120
USER_STYLE_BUDGET: Final[int] = 200
USER_FACTS_BUDGET: Final[int] = 250
SOCIAL_CONTEXT_BUDGET: Final[int] = 200
RECENT_CONTEXT_BUDGET: Final[int] = 300
RELEVANT_EPISODES_BUDGET: Final[int] = 400

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


from lokidoki.orchestrator.memory.slot_renderers import (  # noqa: E402
    render_recent_context,
    render_recent_mood,
    render_relevant_episodes,
    render_social_context,
    render_user_facts,
    render_user_style,
)


def assemble_user_facts_slot(
    *,
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    top_k: int = 3,
) -> tuple[str, list[FactHit]]:
    """End-to-end slot assembly for Tier 4. Returns (slot_string, hits)."""
    hits = read_user_facts(store, owner_user_id, query, top_k=top_k)
    return render_user_facts(hits), hits


def assemble_social_context_slot(
    *,
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    top_k: int = 3,
) -> tuple[str, list[PersonHit]]:
    """End-to-end slot assembly for Tier 5. Returns (slot_string, hits)."""
    hits = read_social_context(store, owner_user_id, query, top_k=top_k)
    return render_social_context(hits), hits


def assemble_recent_context_slot(
    *,
    store: MemoryStore,
    session_id: int,
) -> tuple[str, SessionContext]:
    """End-to-end slot assembly for Tier 2. Returns (slot_string, context)."""
    ctx = read_recent_context(store, session_id)
    return render_recent_context(ctx), ctx


def assemble_relevant_episodes_slot(
    *,
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    top_k: int = 2,
    topic_scope: str | None = None,
) -> tuple[str, list[EpisodeHit]]:
    """End-to-end slot assembly for Tier 3. Returns (slot_string, hits)."""
    hits = read_episodes(
        store, owner_user_id, query, top_k=top_k, topic_scope=topic_scope,
    )
    return render_relevant_episodes(hits), hits


def assemble_user_style_slot(
    *,
    store: MemoryStore,
    owner_user_id: int,
) -> tuple[str, dict]:
    """End-to-end slot assembly for Tier 7a. Returns (slot_string, style_dict)."""
    profile = store.get_user_profile(owner_user_id)
    style = profile.get("style") or {}
    if not isinstance(style, dict):
        style = {}
    return render_user_style(style), style


def assemble_recent_mood_slot(
    *,
    store: MemoryStore,
    owner_user_id: int,
    character_id: str,
    days: int = 14,
) -> tuple[str, list[dict]]:
    """End-to-end slot assembly for Tier 6. Returns (slot_string, affect_rows)."""
    rows = store.get_affect_window(
        owner_user_id, character_id=character_id, days=days,
    )
    return render_recent_mood(rows), rows


def _assemble_memory_tiers(
    out: dict[str, str],
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    context: dict,
) -> None:
    """Fill need-gated memory slots: user_facts, social_context, recent_context, relevant_episodes."""
    if context.get("need_preference"):
        rendered, _ = assemble_user_facts_slot(
            store=store, owner_user_id=owner_user_id, query=query,
        )
        out["user_facts"] = rendered
    if context.get("need_social"):
        rendered, _ = assemble_social_context_slot(
            store=store, owner_user_id=owner_user_id, query=query,
        )
        out["social_context"] = rendered
    session_id = context.get("session_id")
    if context.get("need_session_context") and session_id is not None:
        rendered, _ = assemble_recent_context_slot(store=store, session_id=int(session_id))
        out["recent_context"] = rendered
    if context.get("need_episode"):
        rendered, _ = assemble_relevant_episodes_slot(
            store=store, owner_user_id=owner_user_id, query=query,
            topic_scope=context.get("topic_scope"),
        )
        out["relevant_episodes"] = rendered


def _assemble_always_present_tiers(
    out: dict[str, str],
    store: MemoryStore,
    owner_user_id: int,
    character_id: str,
    context: dict,
) -> None:
    """Fill always-present slots: recent_mood (M6), user_style (M5)."""
    if not store.is_sentiment_opted_out(owner_user_id):
        rendered, _ = assemble_recent_mood_slot(
            store=store, owner_user_id=owner_user_id, character_id=character_id,
        )
        out["recent_mood"] = rendered
    if context.get("need_routine"):
        rendered, _ = assemble_user_style_slot(store=store, owner_user_id=owner_user_id)
        out["user_style"] = rendered


def assemble_slots(context: dict) -> dict[str, str]:
    """Return all six prompt slots.

    Pulls the active store + query out of `context` when one of the
    relevant ``need_*`` flags is set. Slots whose tiers haven't shipped
    yet (M4+) return "".
    """
    out = {spec.name: "" for spec in SLOT_SPECS}
    store = context.get("memory_store")
    if not isinstance(store, MemoryStore):
        return out
    owner_user_id = int(context.get("owner_user_id") or 0)
    query = str(context.get("memory_query") or context.get("user_input") or "")
    character_id = str(context.get("character_id") or "default")
    _assemble_memory_tiers(out, store, owner_user_id, query, context)
    _assemble_always_present_tiers(out, store, owner_user_id, character_id, context)
    return out
