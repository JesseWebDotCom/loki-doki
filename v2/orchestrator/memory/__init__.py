"""
v2 memory subsystem — clean-room implementation of the seven-tier model.

This package is intentionally **not** wired into v1's `lokidoki.core.memory_*`
modules. The v1 and v2 memory systems share storage (one SQLite file) only via
the lifecycle described in `docs/MEMORY_DESIGN.md` §7; they share no Python
imports. A clean cutover from v1 to v2 means deleting the v1 modules without
touching this package.

Phase status: M0 — scaffolding only. No runtime logic yet. See
`docs/MEMORY_DESIGN.md` §8 for the phase plan and `M0_STATUS` below for the
current state.
"""
from __future__ import annotations

# Phase identifiers surfaced via the dev-tools v2 status endpoint so the
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

# The "active" phase is the most recent shipped phase. Future phases
# update this constant when they land.
ACTIVE_PHASE_ID = M3_5_PHASE_ID
ACTIVE_PHASE_LABEL = M3_5_PHASE_LABEL
ACTIVE_PHASE_TITLE = M3_5_PHASE_TITLE
ACTIVE_PHASE_STATUS = M3_5_PHASE_STATUS

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
    "ACTIVE_PHASE_ID",
    "ACTIVE_PHASE_LABEL",
    "ACTIVE_PHASE_TITLE",
    "ACTIVE_PHASE_STATUS",
]
