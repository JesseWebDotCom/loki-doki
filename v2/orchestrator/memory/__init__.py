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

# Phase identifier surfaced via the dev-tools v2 status endpoint so the
# UI can show that the memory subsystem is wired in even when the gates,
# classifier, promotion, etc. are still empty stubs.
M0_PHASE_ID = "m0"
M0_PHASE_LABEL = "M0"
M0_PHASE_TITLE = "Memory: Prerequisites and Corpora"
M0_PHASE_STATUS = "complete"

__all__ = [
    "M0_PHASE_ID",
    "M0_PHASE_LABEL",
    "M0_PHASE_TITLE",
    "M0_PHASE_STATUS",
]
