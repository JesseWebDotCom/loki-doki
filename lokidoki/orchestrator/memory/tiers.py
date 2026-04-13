"""
Seven-tier identifiers and tier metadata.

The tiers are *policies and views* over a single SQLite store; this module
gives the rest of the memory subsystem a typed handle on which tier a
candidate, slot, or retrieval is targeting. See `docs/MEMORY_DESIGN.md` §2.

Phase status: M0 — populated, no consumers yet. Each tier's actual storage
and retrieval mechanism lands in its own M-phase (M1: 4/5, M2: 4 read,
M3: 5 read, M4: 2/3, M5: 7, M6: 6).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Final


class Tier(IntEnum):
    """Stable integer identifiers for the seven memory tiers."""

    WORKING = 1
    SESSION = 2
    EPISODIC = 3
    SEMANTIC_SELF = 4
    SOCIAL = 5
    EMOTIONAL = 6
    PROCEDURAL = 7


@dataclass(frozen=True)
class TierSpec:
    """Static metadata for a tier; used by the dev-tools status surface."""

    tier: Tier
    name: str
    title: str
    storage: str
    landing_phase: str  # the M-phase that first activates this tier


TIER_SPECS: Final[dict[Tier, TierSpec]] = {
    Tier.WORKING: TierSpec(
        tier=Tier.WORKING,
        name="working",
        title="Working (per-turn, volatile)",
        storage="in-memory request context",
        landing_phase="already live",
    ),
    Tier.SESSION: TierSpec(
        tier=Tier.SESSION,
        name="session",
        title="Session (active thread)",
        storage="messages + sessions.session_state JSON",
        landing_phase="M4",
    ),
    Tier.EPISODIC: TierSpec(
        tier=Tier.EPISODIC,
        name="episodic",
        title="Episodic (durable, summarized)",
        storage="episodes + episodes_fts + vec_episodes",
        landing_phase="M4",
    ),
    Tier.SEMANTIC_SELF: TierSpec(
        tier=Tier.SEMANTIC_SELF,
        name="semantic_self",
        title="Semantic-self (durable, fact-shaped)",
        storage="facts + facts_fts + vec_facts",
        landing_phase="M1 (write) / M2 (read)",
    ),
    Tier.SOCIAL: TierSpec(
        tier=Tier.SOCIAL,
        name="social",
        title="Social/relational (durable, graph-shaped)",
        storage="people + relationships + ambiguity_groups",
        landing_phase="M1 (write) / M3 (read)",
    ),
    Tier.EMOTIONAL: TierSpec(
        tier=Tier.EMOTIONAL,
        name="emotional",
        title="Emotional/affective (rolling, character-overlaid)",
        storage="affect_window (per character_id)",
        landing_phase="M6",
    ),
    Tier.PROCEDURAL: TierSpec(
        tier=Tier.PROCEDURAL,
        name="procedural",
        title="Procedural (learned, implicit)",
        storage="behavior_events + user_profile {style, telemetry}",
        landing_phase="M5",
    ),
}


def tier_spec(tier: Tier) -> TierSpec:
    """Return the static spec for `tier`."""
    return TIER_SPECS[tier]
