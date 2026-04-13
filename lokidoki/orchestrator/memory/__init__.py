"""
memory subsystem — clean-room implementation of the seven-tier model.

This package owns the memory subsystem. The memory system and the core
chat-history module share storage (one SQLite file) only via the lifecycle
described in `docs/DESIGN.md` §6 (Memory System); they share no Python imports.
"""
from __future__ import annotations

# Phase identifiers surfaced via the dev-tools status endpoint so the
# UI can show which milestone the memory subsystem is currently shipping.
# M0 (scaffolding) is complete; M1 (write path) is the active phase.
M0_PHASE_ID = "m0"
M0_PHASE_LABEL = "M0"
M0_PHASE_TITLE = "Memory: Prerequisites and Corpora"
M0_PHASE_STATUS = "complete"

M1_PHASE_ID = "m1"
M1_PHASE_LABEL = "M1"
M1_PHASE_TITLE = "Memory: Write Path (Tier 4/5)"
M1_PHASE_STATUS = "complete"

M2_PHASE_ID = "m2"
M2_PHASE_LABEL = "M2"
M2_PHASE_TITLE = "Memory: Read Path (Tier 4 FTS5+RRF)"
M2_PHASE_STATUS = "complete"

M3_PHASE_ID = "m3"
M3_PHASE_LABEL = "M3"
M3_PHASE_TITLE = "Memory: Tier 5 Social (people graph + provisional handles)"
M3_PHASE_STATUS = "complete"

M3_5_PHASE_ID = "m3_5"
M3_5_PHASE_LABEL = "M3.5"
M3_5_PHASE_TITLE = "Memory: Auto-merge by relation"
M3_5_PHASE_STATUS = "complete"

M2_5_PHASE_ID = "m2_5"
M2_5_PHASE_LABEL = "M2.5"
M2_5_PHASE_TITLE = "Memory: Vector embeddings as third RRF source"
M2_5_PHASE_STATUS = "complete"

M4_PHASE_ID = "m4"
M4_PHASE_LABEL = "M4"
M4_PHASE_TITLE = "Memory: Session state + Episodic + Promotion + Consolidation"
M4_PHASE_STATUS = "complete"

M5_PHASE_ID = "m5"
M5_PHASE_LABEL = "M5"
M5_PHASE_TITLE = "Memory: Procedural (Tier 7a/7b) + Behavior Events"
M5_PHASE_STATUS = "complete"

M6_PHASE_ID = "m6"
M6_PHASE_LABEL = "M6"
M6_PHASE_TITLE = "Memory: Affective (Tier 6, Character Overlay)"
M6_PHASE_STATUS = "complete"

# The "active" phase is the most recent shipped phase. Future phases
# update this constant when they land.
ACTIVE_PHASE_ID = M6_PHASE_ID
ACTIVE_PHASE_LABEL = M6_PHASE_LABEL
ACTIVE_PHASE_TITLE = M6_PHASE_TITLE
ACTIVE_PHASE_STATUS = M6_PHASE_STATUS

__all__ = [
    "M0_PHASE_ID",
    "M0_PHASE_LABEL",
    "M0_PHASE_TITLE",
    "M0_PHASE_STATUS",
    "M1_PHASE_ID",
    "M1_PHASE_LABEL",
    "M1_PHASE_TITLE",
    "M1_PHASE_STATUS",
    "M2_PHASE_ID",
    "M2_PHASE_LABEL",
    "M2_PHASE_TITLE",
    "M2_PHASE_STATUS",
    "M3_PHASE_ID",
    "M3_PHASE_LABEL",
    "M3_PHASE_TITLE",
    "M3_PHASE_STATUS",
    "M4_PHASE_ID",
    "M4_PHASE_LABEL",
    "M4_PHASE_TITLE",
    "M4_PHASE_STATUS",
    "M5_PHASE_ID",
    "M5_PHASE_LABEL",
    "M5_PHASE_TITLE",
    "M5_PHASE_STATUS",
    "M6_PHASE_ID",
    "M6_PHASE_LABEL",
    "M6_PHASE_TITLE",
    "M6_PHASE_STATUS",
    "ACTIVE_PHASE_ID",
    "ACTIVE_PHASE_LABEL",
    "ACTIVE_PHASE_TITLE",
    "ACTIVE_PHASE_STATUS",
]
