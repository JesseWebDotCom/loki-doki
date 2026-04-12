"""
Dev-tools test memory store.

This is a process-singleton :class:`V2MemoryStore` backed by a sqlite
file under ``data/v2_dev_memory.sqlite``. It exists so the dev-tools v2
test page can write to and read from a real memory store **without
touching the production v2 store** (``data/v2_memory.sqlite``). The
file is owned entirely by the dev tools and the user can reset it with
one button click.

The dev-tools owner_user_id is fixed at :data:`DEV_OWNER_USER_ID` so
multiple test prompts compose into a single coherent persona without
the user having to remember an id.
"""
from __future__ import annotations

import threading
from pathlib import Path

from v2.orchestrator.memory.store import V2MemoryStore

DEV_DB_PATH = Path("data/v2_dev_memory.sqlite")
DEV_OWNER_USER_ID: int = 1

_lock = threading.Lock()
_store: V2MemoryStore | None = None


def get_dev_store() -> V2MemoryStore:
    """Return the singleton dev-tools test store, creating it on first use."""
    global _store
    with _lock:
        if _store is None:
            _store = V2MemoryStore(DEV_DB_PATH)
        return _store


def reset_dev_store() -> dict[str, int]:
    """Wipe the dev-tools test store and return a summary of what was cleared.

    Drops the existing connection, deletes the file, and creates a fresh
    store. Returns counts so the dev tools UI can confirm.
    """
    global _store
    with _lock:
        prior_facts = 0
        prior_people = 0
        if _store is not None:
            prior_facts = len(_store.get_active_facts(DEV_OWNER_USER_ID)) + len(
                _store.get_superseded_facts(DEV_OWNER_USER_ID)
            )
            prior_people = len(_store.get_people(DEV_OWNER_USER_ID))
            _store.close()
            _store = None
        if DEV_DB_PATH.exists():
            DEV_DB_PATH.unlink()
        _store = V2MemoryStore(DEV_DB_PATH)
        return {
            "facts_cleared": prior_facts,
            "people_cleared": prior_people,
        }


def dump_dev_store() -> dict[str, list[dict]]:
    """Return all active facts, superseded facts, people, and relationships
    for the fixed dev owner_user_id. Used by the dev-tools state panel."""
    store = get_dev_store()
    return {
        "active_facts": store.get_active_facts(DEV_OWNER_USER_ID),
        "superseded_facts": store.get_superseded_facts(DEV_OWNER_USER_ID),
        "people": store.get_people(DEV_OWNER_USER_ID),
        "relationships": store.get_relationships(DEV_OWNER_USER_ID),
    }
