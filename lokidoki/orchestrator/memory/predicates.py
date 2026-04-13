"""
Predicate enums and constants for the memory write path.

These constants drive Gate 3 (predicate validity), the immediate-durable
fast-path, and the single-value supersession rule. They are intentionally
Python constants — never prompt strings — so the model can never widen them
by accident.

Phase status: M0 — populated, no consumers yet. M1 wires the gate chain.
See `docs/DESIGN.md` §6.3 (Gate 3, immediate-durable carve-out) and §5
(contradiction / single-value rule).
"""
from __future__ import annotations

from typing import Final, FrozenSet

# ----- Tier 4 (semantic-self) predicates ------------------------------------
# Closed enum. Free-text predicates emitted by an LLM are coerced to the
# nearest entry or rejected by Gate 3.
TIER4_PREDICATES: Final[FrozenSet[str]] = frozenset(
    {
        "is_named",
        "has_pronoun",
        "prefers",
        "lives_in",
        "works_as",
        "was_born",
        "owns",
        "has_constraint",
        "has_allergy",
        "has_dietary_restriction",
        "has_accessibility_need",
        "has_privacy_boundary",
        "hard_dislike",
        "current_employer",
        "current_partner",
        "currently_lives_with",
        "favorite_color",
        "favorite_food",
        "favorite_movie",
        "preferred_modality",
        "preferred_units",
        "timezone",
    }
)

# ----- Tier 5 (social) predicates -------------------------------------------
TIER5_PREDICATES: Final[FrozenSet[str]] = frozenset(
    {
        "is_named",
        "is_relation",
        "has_pronoun",
        "lives_in",
        "has_birthday",
        "prefers",
    }
)

# ----- Immediate-durable carve-out (§3 Layer 3) ------------------------------
# Predicates that bypass the 3-session promotion rule and write straight to
# Tier 4 / Tier 5 on the first observation, *provided* they pass Layers 1 + 2.
# Promotion-bypass is eligibility, not gate-bypass.
IMMEDIATE_DURABLE_TIER4: Final[FrozenSet[str]] = frozenset(
    {
        "is_named",
        "has_pronoun",
        "has_allergy",
        "has_dietary_restriction",
        "has_accessibility_need",
        "has_privacy_boundary",
        "hard_dislike",
    }
)

IMMEDIATE_DURABLE_TIER5: Final[FrozenSet[str]] = frozenset(
    {
        "is_named",
        "is_relation",
        "has_pronoun",
    }
)

# ----- Single-value predicates (§5 contradiction) ---------------------------
# For these predicates, recency dominates frequency: a new value supersedes
# the old immediately, prior value's status flips to `superseded`, prior
# value's confidence drops to floor 0.1.
SINGLE_VALUE_PREDICATES: Final[FrozenSet[str]] = frozenset(
    {
        "is_named",
        "has_pronoun",
        "lives_in",
        "works_as",
        "current_employer",
        "current_partner",
        "currently_lives_with",
        "favorite_color",
        "favorite_food",
        "favorite_movie",
        "preferred_modality",
        "preferred_units",
        "timezone",
    }
)

# Confidence floor for superseded single-value predicates.
SUPERSEDED_CONFIDENCE_FLOOR: Final[float] = 0.1


def is_tier4_predicate(predicate: str) -> bool:
    """Return True if `predicate` is a valid Tier 4 (semantic-self) predicate."""
    return predicate in TIER4_PREDICATES


def is_tier5_predicate(predicate: str) -> bool:
    """Return True if `predicate` is a valid Tier 5 (social) predicate."""
    return predicate in TIER5_PREDICATES


def is_immediate_durable(tier: int, predicate: str) -> bool:
    """Return True if `predicate` bypasses promotion in the given tier."""
    if tier == 4:
        return predicate in IMMEDIATE_DURABLE_TIER4
    if tier == 5:
        return predicate in IMMEDIATE_DURABLE_TIER5
    return False


def is_single_value(predicate: str) -> bool:
    """Return True if `predicate` is recency-dominated (new supersedes old)."""
    return predicate in SINGLE_VALUE_PREDICATES
