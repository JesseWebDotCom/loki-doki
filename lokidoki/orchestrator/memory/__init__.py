"""
memory subsystem — implementation of the seven-tier model.

This package owns the memory subsystem. Storage is the single SQLite
file at ``data/lokidoki.db``, shared with the chat-history module but
with no Python imports crossing the boundary (see ``docs/DESIGN.md``
§6 Memory System).
"""
from __future__ import annotations

# Single status surfaced by the dev-tools endpoint. The per-phase
# milestone constants (M0 … M6) were removed after the memory
# unification shipped; the dev-tools UI now renders one block.
MEMORY_SUBSYSTEM_ID = "memory"
MEMORY_SUBSYSTEM_LABEL = "Memory"
MEMORY_SUBSYSTEM_TITLE = "Memory subsystem"
MEMORY_SUBSYSTEM_STATUS = "shipped"

__all__ = [
    "MEMORY_SUBSYSTEM_ID",
    "MEMORY_SUBSYSTEM_LABEL",
    "MEMORY_SUBSYSTEM_TITLE",
    "MEMORY_SUBSYSTEM_STATUS",
]
