"""Humanization helpers for the synthesis prompt.

The decomposer extracts structured facts; the synthesizer needs them
back as natural-sounding context the model can paraphrase. This module
turns ``valid_from`` timestamps into relative time phrases ("3 days
ago") and assembles the full memory block the synthesizer sees.

These are pure formatting functions — no I/O, no model calls — so
they're trivial to unit-test and they don't push orchestrator.py
over the 250-line ceiling.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional


def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    """Tolerantly parse an SQLite ``datetime('now')`` string.

    SQLite stores timestamps in ``YYYY-MM-DD HH:MM:SS`` form by default
    (no timezone). We treat them as UTC because that's what the
    ``datetime('now')`` default emits.
    """
    if not ts:
        return None
    try:
        # Try ISO 8601 first (covers user-supplied strings).
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def relative_time(ts: Optional[str], *, now: Optional[datetime] = None) -> str:
    """Return a short human phrase like 'today', '3 days ago', 'last month'.

    Returns ``""`` when the timestamp can't be parsed — callers should
    treat that as "no temporal info" rather than crashing.
    """
    parsed = _parse_iso(ts)
    if parsed is None:
        return ""
    reference = now or datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = reference - parsed
    seconds = int(delta.total_seconds())
    if seconds < 0:
        return "just now"
    minutes = seconds // 60
    hours = minutes // 60
    days = hours // 24
    if seconds < 60:
        return "just now"
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"
    if hours < 24:
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    if days == 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    if days < 14:
        return "last week"
    if days < 30:
        return f"{days // 7} weeks ago"
    if days < 60:
        return "last month"
    if days < 365:
        return f"{days // 30} months ago"
    if days < 730:
        return "last year"
    return f"{days // 365} years ago"


def _fact_phrase(fact: dict) -> str:
    """Render one fact as a natural English clause.

    The synthesizer is a small model — give it readable English, not
    triples. We special-case ``self`` so the result reads as second
    person ("you said you love coffee") and falls back to a neutral
    third-person form for entity/person rows.
    """
    subject = (fact.get("subject") or "").strip()
    subject_type = fact.get("subject_type") or "self"
    predicate = (fact.get("predicate") or "").strip().replace("_", " ")
    value = (fact.get("value") or "").strip()
    if not (predicate and value):
        return ""
    if subject_type == "self" or subject == "self":
        return f"you {predicate} {value}"
    return f"{subject} {predicate} {value}"


def format_memory_block(
    *,
    facts: Iterable[dict],
    past_messages: Iterable[dict],
    now: Optional[datetime] = None,
    max_facts: int = 6,
    max_messages: int = 4,
) -> str:
    """Render the WHAT_YOU_REMEMBER block injected into synthesis.

    Two sub-sections, both bullet-style and capped:
      - Facts: temporal phrase + natural-language clause, e.g.
        "yesterday: you mentioned biodome was pretty good"
      - Past turns: timestamp + verbatim user content, e.g.
        "3 days ago you said: \"what is the movie with ryan reynolds\""

    Returns "" when both sources are empty so the caller can omit the
    whole block from the prompt rather than emitting a sad header.
    """
    fact_lines: list[str] = []
    for f in list(facts)[:max_facts]:
        phrase = _fact_phrase(f)
        if not phrase:
            continue
        when = relative_time(
            f.get("valid_from") or f.get("last_observed_at") or f.get("created_at"),
            now=now,
        )
        fact_lines.append(f"- {when}: {phrase}" if when else f"- {phrase}")

    msg_lines: list[str] = []
    for m in list(past_messages)[:max_messages]:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        when = relative_time(m.get("created_at"), now=now)
        snippet = content if len(content) <= 140 else content[:137] + "..."
        msg_lines.append(
            f"- {when}, in an earlier chat, you said: \"{snippet}\"" if when
            else f"- in an earlier chat you said: \"{snippet}\""
        )

    if not fact_lines and not msg_lines:
        return ""

    parts: list[str] = []
    if fact_lines:
        parts.append("FACTS:")
        parts.extend(fact_lines)
    if msg_lines:
        # Header makes the boundary explicit so the synthesizer never
        # treats these as part of the current conversation. These are
        # BM25 hits from OLDER sessions; if you reference one, frame it
        # as "a while back" — never as "what we were just talking about".
        parts.append("FROM_OLDER_SESSIONS (not the current chat):")
        parts.extend(msg_lines)
    return "\n".join(parts)


def aggregate_sentiment_arc(
    recent: list[dict],
    *,
    window: int = 5,
) -> str:
    """Pick a single descriptor for the user's recent emotional arc.

    ``recent`` is a list of ``{sentiment: str, created_at: str}`` rows
    from the sentiment_log table, ordered newest first. We don't try
    to be clever — count the occurrences in the window and return the
    dominant non-neutral sentiment, or "" when the user has been
    neutral or hasn't said enough yet.
    """
    if not recent:
        return ""
    counts: dict[str, int] = {}
    for row in recent[:window]:
        s = (row.get("sentiment") or "").strip().lower()
        if not s or s in ("neutral", "none"):
            continue
        counts[s] = counts.get(s, 0) + 1
    if not counts:
        return ""
    # Need at least two occurrences to call something an arc — a
    # single off-mood turn isn't a trend.
    dominant = max(counts.items(), key=lambda kv: kv[1])
    if dominant[1] < 2:
        return ""
    return dominant[0]
