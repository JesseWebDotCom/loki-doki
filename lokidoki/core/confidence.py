"""Pure confidence-update math for the memory layer.

Kept in its own module so the math is unit-testable without dragging in
SQLite or any I/O. The MemoryProvider calls ``update_confidence`` whenever
a fact is re-asserted (dedup-and-confirm) or contradicted.
"""
from __future__ import annotations

# Bounds for confidence scores. We never let a fact reach exactly 0 or 1
# so that a single new observation can always move the needle.
MIN_CONFIDENCE = 0.05
MAX_CONFIDENCE = 0.99

# Default starting confidence for a freshly-extracted fact.
DEFAULT_CONFIDENCE = 0.6


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
