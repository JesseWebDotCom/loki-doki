"""
Memory storage layer.

The memory store opens its **own** SQLite file at
``data/memory.sqlite`` (configurable per-instance) and writes to its
own tables.

The ``MemoryStore`` class composes domain-specific mixins from the
``store_*.py`` siblings. Each mixin holds one tier's methods. This file
keeps connection setup, schema bootstrap, ``WriteOutcome``, and the
module-level singleton.
"""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

from lokidoki.orchestrator.memory.store_affect import AffectMixin
from lokidoki.orchestrator.memory.store_behavior import BehaviorMixin
from lokidoki.orchestrator.memory.store_episodes import EpisodesMixin
from lokidoki.orchestrator.memory.store_facts import FactsMixin, compute_fact_embedding
from lokidoki.orchestrator.memory.store_helpers import _now
from lokidoki.orchestrator.memory.store_schema import MEMORY_CORE_SCHEMA
from lokidoki.orchestrator.memory.store_sessions import SessionsMixin
from lokidoki.orchestrator.memory.store_social import SocialMixin
from lokidoki.orchestrator.memory.tiers import Tier

DEFAULT_DB_PATH = Path("data/memory.sqlite")


@dataclass(frozen=True)
class WriteOutcome:
    """Result of a single write through the store."""

    accepted: bool
    tier: Tier | None
    fact_id: int | None
    person_id: int | None
    superseded_id: int | None
    immediate_durable: bool
    note: str = ""


class MemoryStore(
    FactsMixin,
    SocialMixin,
    SessionsMixin,
    EpisodesMixin,
    BehaviorMixin,
    AffectMixin,
):
    """Thread-safe SQLite store for the memory subsystem.

    Composes tier-specific mixins so each domain lives in its own file.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        if db_path is None:
            db_path = DEFAULT_DB_PATH
        if isinstance(db_path, Path):
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._db_uri: str | Path = db_path
        else:
            self._db_uri = db_path
        self._conn = sqlite3.connect(
            str(self._db_uri),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON;")
        self._bootstrap()

    def _bootstrap(self) -> None:
        with self._lock:
            self._conn.executescript(MEMORY_CORE_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# ---------------------------------------------------------------------------
# Module-level singleton (lazy)
# ---------------------------------------------------------------------------

_GLOBAL_STORE: MemoryStore | None = None
_GLOBAL_LOCK = threading.Lock()


def get_default_store() -> MemoryStore:
    """Return the process-wide default store, creating it on first call."""
    global _GLOBAL_STORE
    with _GLOBAL_LOCK:
        if _GLOBAL_STORE is None:
            _GLOBAL_STORE = MemoryStore()
        return _GLOBAL_STORE


def reset_default_store(new_store: MemoryStore | None = None) -> None:
    """Replace the process-wide store. Used by tests and the dev tools."""
    global _GLOBAL_STORE
    with _GLOBAL_LOCK:
        if _GLOBAL_STORE is not None and _GLOBAL_STORE is not new_store:
            _GLOBAL_STORE.close()
        _GLOBAL_STORE = new_store


# Re-exports so existing ``from store import X`` statements still work.
__all__ = [
    "DEFAULT_DB_PATH",
    "MEMORY_CORE_SCHEMA",
    "MemoryStore",
    "WriteOutcome",
    "_now",
    "compute_fact_embedding",
    "get_default_store",
    "reset_default_store",
]
