"""Render functions for synthesis prompt slots.

Each render function converts raw tier data into a compact string
for the synthesizer prompt. All renderers enforce their per-slot
char budget via ``truncate_to_budget``.
"""
from __future__ import annotations

from typing import Iterable

from lokidoki.orchestrator.memory.reader import (
    EpisodeHit,
    FactHit,
    PersonHit,
    SessionContext,
)
from lokidoki.orchestrator.memory.slots_base import (
    STYLE_DESCRIPTORS,
    truncate_to_budget,
)


def render_user_facts(hits: Iterable[FactHit]) -> str:
    """Render Tier 4 fact hits into the ``{user_facts}`` slot string."""
    parts: list[str] = []
    for hit in hits:
        if hit.subject == "self":
            parts.append(f"{hit.predicate}={hit.value}")
        else:
            parts.append(f"{hit.subject} {hit.predicate}={hit.value}")
    return truncate_to_budget("user_facts", "; ".join(parts))


def render_social_context(hits: Iterable[PersonHit]) -> str:
    """Render Tier 5 person hits into the ``{social_context}`` slot string."""
    parts: list[str] = []
    for hit in hits:
        label = hit.name or hit.handle or "person"
        if hit.relations:
            parts.append(f"{label}={'/'.join(hit.relations)}")
        else:
            parts.append(label)
    return truncate_to_budget("social_context", "; ".join(parts))


def render_recent_context(session_ctx: SessionContext) -> str:
    """Render Tier 2 session context into the ``{recent_context}`` slot."""
    if not session_ctx.last_seen:
        return ""
    parts: list[str] = []
    for key, entry in sorted(session_ctx.last_seen.items()):
        name = entry.get("name", "") if isinstance(entry, dict) else str(entry)
        if name:
            parts.append(f"{key}={name}")
    return truncate_to_budget("recent_context", "; ".join(parts))


def render_relevant_episodes(hits: Iterable[EpisodeHit]) -> str:
    """Render Tier 3 episode hits into the ``{relevant_episodes}`` slot."""
    parts: list[str] = []
    for hit in hits:
        summary_short = hit.summary[:100]
        if len(hit.summary) > 100:
            summary_short = summary_short.rsplit(" ", 1)[0] + "..."
        date_part = hit.start_at[:10] if hit.start_at else "?"
        parts.append(f"[{date_part}] {hit.title}: {summary_short}")
    return truncate_to_budget("relevant_episodes", " | ".join(parts))


def render_user_style(style_data: dict) -> str:
    """Render Tier 7a user style into the ``{user_style}`` slot string."""
    if not style_data:
        return ""
    parts: list[str] = []
    for key in STYLE_DESCRIPTORS:
        val = style_data.get(key)
        if val:
            parts.append(f"{key}={val}")
    return truncate_to_budget("user_style", "; ".join(parts))


CONVERSATION_HISTORY_BUDGET = 1500


def render_conversation_history(messages: list[dict[str, str]]) -> str:
    """Render recent conversation messages into the ``{conversation_history}`` slot.

    Takes a list of ``{"role": ..., "content": ...}`` dicts (oldest first)
    and renders the most recent exchanges that fit within the char budget.
    The current user turn is excluded (it's already in the spec).
    """
    if not messages:
        return ""
    # Exclude the last message if it's the current user turn (already in spec).
    if messages and messages[-1].get("role") == "user":
        messages = messages[:-1]
    if not messages:
        return ""
    # Build lines from newest to oldest, stop when budget is exceeded.
    lines: list[str] = []
    remaining = CONVERSATION_HISTORY_BUDGET
    for msg in reversed(messages):
        role = msg.get("role", "?")
        content = (msg.get("content") or "").strip()
        if not content:
            continue
        # Truncate individual messages to ~250 chars.
        if len(content) > 250:
            content = content[:247].rsplit(" ", 1)[0] + "..."
        line = f"{role}: {content}"
        if len(line) > remaining:
            break
        lines.append(line)
        remaining -= len(line) + 1  # +1 for newline
    if not lines:
        return ""
    lines.reverse()
    return "\n".join(lines)


def render_recent_mood(affect_rows: list[dict]) -> str:
    """Render Tier 6 affect window into the ``{recent_mood}`` slot string."""
    if not affect_rows:
        return ""
    avg = sum(r["sentiment_avg"] for r in affect_rows) / len(affect_rows)
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
    return truncate_to_budget("recent_mood", f"mood={mood}; trend={trend}")
