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

Total worst-case slot budget is 1,470 chars per `docs/DESIGN.md` §6.4.
"""
from __future__ import annotations

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
from lokidoki.orchestrator.memory.slots_base import (
    SLOT_SPECS,
    STYLE_DESCRIPTORS,
    SlotSpec,
    truncate_to_budget,
)
from lokidoki.orchestrator.memory.store import MemoryStore

# Re-export renderers for test and pipeline convenience
from lokidoki.orchestrator.memory.slot_renderers import (
    render_recent_context,
    render_recent_mood,
    render_relevant_episodes,
    render_social_context,
    render_user_facts,
    render_user_style,
)

WORST_CASE_TOTAL_BUDGET: Final[int] = sum(spec.char_budget for spec in SLOT_SPECS)
assert WORST_CASE_TOTAL_BUDGET == 1470, "Slot budget total drifted from §4"

RECENT_MOOD_BUDGET: Final[int] = 120
USER_STYLE_BUDGET: Final[int] = 200
USER_FACTS_BUDGET: Final[int] = 250
SOCIAL_CONTEXT_BUDGET: Final[int] = 200
RECENT_CONTEXT_BUDGET: Final[int] = 300
RELEVANT_EPISODES_BUDGET: Final[int] = 400


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
    session_ids: tuple[int, ...] | None = None,
) -> tuple[str, list[EpisodeHit]]:
    """End-to-end slot assembly for Tier 3. Returns (slot_string, hits)."""
    hits = read_episodes(
        store,
        owner_user_id,
        query,
        top_k=top_k,
        topic_scope=topic_scope,
        session_ids=session_ids,
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
            session_ids=tuple(context.get("workspace_session_ids") or ()) or None,
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
    provider = context.get("memory_provider")
    store = getattr(provider, "store", None) if provider is not None else None
    if not isinstance(store, MemoryStore):
        return out
    owner_user_id = int(context.get("owner_user_id") or 0)
    query = str(context.get("memory_query") or context.get("user_input") or "")
    character_id = str(context.get("character_id") or "default")
    _assemble_memory_tiers(out, store, owner_user_id, query, context)
    _assemble_always_present_tiers(out, store, owner_user_id, character_id, context)
    return out
