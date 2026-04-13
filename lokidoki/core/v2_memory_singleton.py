"""Process-wide V2MemoryStore singleton for production use.

The v2 memory store (``data/v2_memory.sqlite``) holds facts, people,
episodes, sessions, affect windows, and behavior events written by the
v2 pipeline.  This is separate from the v1 ``MemoryProvider``
(``data/lokidoki.db``) which still owns chat history, auth, and
settings.

Tests override via ``set_v2_memory_store``.
"""
from __future__ import annotations

import threading

from v2.orchestrator.memory.store import V2MemoryStore


_lock = threading.Lock()
_store: V2MemoryStore | None = None


def get_v2_memory_store() -> V2MemoryStore:
    """Return the singleton production v2 store, creating on first use."""
    global _store
    with _lock:
        if _store is None:
            _store = V2MemoryStore()  # defaults to data/v2_memory.sqlite
        return _store


def set_v2_memory_store(store: V2MemoryStore | None) -> None:
    """Test hook: replace the singleton (or clear with None)."""
    global _store
    with _lock:
        _store = store
