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
    EpisodeHit,
    FactHit,
    PersonHit,
    SessionContext,
    read_episodes,
    read_recent_context,
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


def render_recent_context(session_ctx: SessionContext) -> str:
    """Render Tier 2 session context into the ``{recent_context}`` slot.

    Format: a semicolon-separated list of ``last_<type>=<name>`` pairs
    from the session's last-seen map. Truncated to 300 chars.
    """
    if not session_ctx.last_seen:
        return ""
    parts: list[str] = []
    for key, entry in sorted(session_ctx.last_seen.items()):
        name = entry.get("name", "") if isinstance(entry, dict) else str(entry)
        if name:
            parts.append(f"{key}={name}")
    rendered = "; ".join(parts)
    return truncate_to_budget("recent_context", rendered)


def assemble_recent_context_slot(
    *,
    store: V2MemoryStore,
    session_id: int,
) -> tuple[str, SessionContext]:
    """End-to-end slot assembly for Tier 2. Returns (slot_string, context)."""
    ctx = read_recent_context(store, session_id)
    return render_recent_context(ctx), ctx


def render_relevant_episodes(hits: Iterable[EpisodeHit]) -> str:
    """Render Tier 3 episode hits into the ``{relevant_episodes}`` slot.

    Format per episode: ``[<start_at>] <title>: <summary_truncated>``.
    Multiple episodes separated by `` | ``. Truncated to 400 chars.
    """
    parts: list[str] = []
    for hit in hits:
        # Compact: date + title + first ~100 chars of summary
        summary_short = hit.summary[:100]
        if len(hit.summary) > 100:
            summary_short = summary_short.rsplit(" ", 1)[0] + "..."
        date_part = hit.start_at[:10] if hit.start_at else "?"
        parts.append(f"[{date_part}] {hit.title}: {summary_short}")
    rendered = " | ".join(parts)
    return truncate_to_budget("relevant_episodes", rendered)


def assemble_relevant_episodes_slot(
    *,
    store: V2MemoryStore,
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


def render_user_style(style_data: dict) -> str:
    """Render Tier 7a user style into the ``{user_style}`` slot string.

    Format: semicolon-separated ``key=value`` pairs for each non-empty
    style descriptor. Truncated to 200 chars.
    """
    if not style_data:
        return ""
    parts: list[str] = []
    for key in STYLE_DESCRIPTORS:
        val = style_data.get(key)
        if val:
            parts.append(f"{key}={val}")
    rendered = "; ".join(parts)
    return truncate_to_budget("user_style", rendered)


def assemble_user_style_slot(
    *,
    store: V2MemoryStore,
    owner_user_id: int,
) -> tuple[str, dict]:
    """End-to-end slot assembly for Tier 7a. Returns (slot_string, style_dict)."""
    profile = store.get_user_profile(owner_user_id)
    style = profile.get("style") or {}
    if not isinstance(style, dict):
        style = {}
    return render_user_style(style), style


def render_recent_mood(affect_rows: list[dict]) -> str:
    """Render Tier 6 affect window into the ``{recent_mood}`` slot string.

    Format: ``mood=<label>; trend=<direction>`` derived from the 14-day
    rolling sentiment average. Truncated to 120 chars.
    """
    if not affect_rows:
        return ""
    # Average sentiment over the window
    avg = sum(r["sentiment_avg"] for r in affect_rows) / len(affect_rows)
    # Derive mood label from average
    if avg >= 0.5:
        mood = "positive"
    elif avg >= 0.15:
        mood = "slightly_positive"
    elif avg > -0.15:
        mood = "neutral"
    elif avg > -0.5:
        mood = "slightly_negative"
    else:
        mood = "negative"
    # Derive trend from most recent vs oldest
    if len(affect_rows) >= 2:
        recent = affect_rows[0]["sentiment_avg"]
        oldest = affect_rows[-1]["sentiment_avg"]
        diff = recent - oldest
        if diff > 0.2:
            trend = "improving"
        elif diff < -0.2:
            trend = "declining"
        else:
            trend = "stable"
    else:
        trend = "stable"
    rendered = f"mood={mood}; trend={trend}"
    return truncate_to_budget("recent_mood", rendered)


def assemble_recent_mood_slot(
    *,
    store: V2MemoryStore,
    owner_user_id: int,
    character_id: str,
    days: int = 14,
) -> tuple[str, list[dict]]:
    """End-to-end slot assembly for Tier 6. Returns (slot_string, affect_rows)."""
    rows = store.get_affect_window(
        owner_user_id, character_id=character_id, days=days,
    )
    return render_recent_mood(rows), rows


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

    # Tier 2 (M4)
    session_id = context.get("session_id")
    if context.get("need_session_context") and session_id is not None:
        rendered, _ctx = assemble_recent_context_slot(
            store=store,
            session_id=int(session_id),
        )
        out["recent_context"] = rendered

    # Tier 3 (M4)
    if context.get("need_episode"):
        topic_scope = context.get("topic_scope")
        rendered, _hits = assemble_relevant_episodes_slot(
            store=store,
            owner_user_id=owner_user_id,
            query=query,
            topic_scope=topic_scope,
        )
        out["relevant_episodes"] = rendered

    # Tier 6 (M6) — always_present=True. Gated on sentiment opt-out.
    character_id = str(context.get("character_id") or "default")
    if not store.is_sentiment_opted_out(owner_user_id):
        rendered, _rows = assemble_recent_mood_slot(
            store=store,
            owner_user_id=owner_user_id,
            character_id=character_id,
        )
        out["recent_mood"] = rendered

    # Tier 7 (M5) — always_present=True, but only assembled when
    # need_routine is set (derivation gates this for every direct_chat
    # or routine-lemma turn).
    if context.get("need_routine"):
        rendered, _style = assemble_user_style_slot(
            store=store,
            owner_user_id=owner_user_id,
        )
        out["user_style"] = rendered

    return out
