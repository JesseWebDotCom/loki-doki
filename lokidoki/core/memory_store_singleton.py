"""Process-wide MemoryStore singleton for production use.

The memory store (``data/memory.sqlite``) holds facts, people,
episodes, sessions, affect windows, and behavior events written by the
pipeline.  This is separate from the ``MemoryProvider``
(``data/lokidoki.db``) which still owns chat history, auth, and
settings.

Tests override via ``set_memory_store``.
"""
from __future__ import annotations

import threading

from lokidoki.orchestrator.memory.store import MemoryStore


_lock = threading.Lock()
_store: MemoryStore | None = None


def get_memory_store() -> MemoryStore:
    """Return the singleton production store, creating on first use."""
    global _store
    with _lock:
        if _store is None:
            _store = MemoryStore()  # defaults to data/memory.sqlite
        return _store


def set_memory_store(store: MemoryStore | None) -> None:
    """Test hook: replace the singleton (or clear with None)."""
    global _store
    with _lock:
        _store = store
