"""Process-wide MemoryProvider singleton.

Auth, admin, chat, and memory routes all need to share the same
provider instance so they hit the same SQLite connection. Tests
override the singleton via ``set_memory_provider``.
"""
from __future__ import annotations

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_user_ops  # noqa: F401  side-effect: bind methods
from lokidoki.core import memory_people_ops  # noqa: F401  side-effect: bind PR3 people helpers

_provider: MemoryProvider | None = None


async def get_memory_provider() -> MemoryProvider:
    global _provider
    if _provider is None:
        _provider = MemoryProvider(db_path="data/lokidoki.db")
        await _provider.initialize()
    return _provider


def set_memory_provider(mp: MemoryProvider | None) -> None:
    """Test hook: replace the singleton (or clear with None)."""
    global _provider
    _provider = mp
