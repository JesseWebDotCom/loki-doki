"""Pure confidence-update math for the memory layer.

Kept in its own module so the math is unit-testable without dragging in
SQLite or any I/O. The MemoryProvider calls ``update_confidence`` whenever
a fact is re-asserted (dedup-and-confirm) or contradicted.

Effective confidence
--------------------
Stored confidence is the long-running EMA. *Effective* confidence is the
stored value decayed by recency: a fact you mentioned a year ago should
weigh less than one you mentioned yesterday. Identity-class facts (name,
relationships) never decay — your brother is still your brother.
"""
from __future__ import annotations

from datetime import datetime, timezone

# Bounds for confidence scores. We never let a fact reach exactly 0 or 1
# so that a single new observation can always move the needle.
MIN_CONFIDENCE = 0.05
MAX_CONFIDENCE = 0.99

# Default starting confidence for a freshly-extracted fact.
DEFAULT_CONFIDENCE = 0.6

# Half-life for general facts. After this many days, a fact's effective
# confidence is half its stored value (assuming no re-observation).
HALF_LIFE_DAYS = 180.0

# Categories that never decay — identity facts are sticky.
NO_DECAY_CATEGORIES = {"identity", "relationship", "biographical"}

# Predicates where only one value can be true at a time. A new value
# triggers belief revision instead of coexisting as a conflict.
SINGLE_VALUE_PREDICATES = {
    "name", "is_named", "named", "called", "is_called",
    "age", "birthday", "born", "lives_in", "located_in",
    "works_at", "married_to", "spouse", "is",
}


def clamp(value: float) -> float:
    """Clamp a confidence value into [MIN_CONFIDENCE, MAX_CONFIDENCE]."""
    if value < MIN_CONFIDENCE:
        return MIN_CONFIDENCE
    if value > MAX_CONFIDENCE:
        return MAX_CONFIDENCE
    return value


def update_confidence(
    current: float,
    confirmed: bool,
    weight: float = 0.2,
) -> float:
    """Return a new confidence score after one observation.

    Pure function. No I/O.

    - ``current``: the existing stored confidence in [0, 1].
    - ``confirmed``: True if the fact was re-asserted, False if contradicted.
    - ``weight``: how strongly the observation moves the score (0..1).
      Larger weight means a single observation has more pull.

    The update rule is exponential moving average toward the target
    (1.0 for confirmed, 0.0 for contradicted), then clamped:

        new = current + weight * (target - current)

    Properties (all pinned by tests in tests/unit/test_confidence.py):
    - confirmation always increases (or holds at MAX) confidence
    - contradiction always decreases (or holds at MIN) confidence
    - the function is idempotent at the bounds
    - weight=0 returns current unchanged (clamped)
    - weight=1 jumps straight to the target (clamped)
    """
    if not 0.0 <= weight <= 1.0:
        raise ValueError(f"weight must be in [0, 1], got {weight}")

    target = 1.0 if confirmed else 0.0
    new = current + weight * (target - current)
    return clamp(new)


def _parse_ts(ts: str) -> datetime:
    """Parse a SQLite ``datetime('now')`` timestamp into a UTC datetime."""
    # SQLite stores 'YYYY-MM-DD HH:MM:SS' (no tz). Treat as UTC.
    try:
        return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def effective_confidence(
    stored: float,
    last_observed_at: str,
    category: str = "general",
    *,
    now: datetime | None = None,
    half_life_days: float = HALF_LIFE_DAYS,
) -> float:
    """Return the recency-decayed confidence for a fact.

    Pure function. Identity-class facts skip decay entirely so a brother
    stays a brother forever. Everything else decays exponentially with a
    180-day half-life by default.
    """
    if category in NO_DECAY_CATEGORIES or half_life_days <= 0:
        return clamp(stored)
    now = now or datetime.now(timezone.utc)
    observed = _parse_ts(last_observed_at)
    age_days = max(0.0, (now - observed).total_seconds() / 86400.0)
    decayed = stored * (0.5 ** (age_days / half_life_days))
    return clamp(decayed)


def is_single_value_predicate(predicate: str) -> bool:
    """True if a new value for this predicate should supersede the old one."""
    return (predicate or "").strip().lower().replace(" ", "_") in SINGLE_VALUE_PREDICATES
