"""Per-session concurrency gate for deep-work turns.

Design §10.4 is explicit: **single concurrent deep turn per session**.
A second deep request while one is in-flight must NOT queue silently;
the runner surfaces a clarification block so the user knows the
earlier deep turn is still working.

The gate is process-local. Distributed sessions are out of scope —
LokiDoki is a single-user local app (design §17.5).

The lock objects here live at module scope intentionally: the same
``session_key`` acquired from two different pipeline tasks must see
the same lock instance. Tests can call :meth:`DeepGate.reset` between
cases to isolate state.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Final

logger = logging.getLogger("lokidoki.orchestrator.deep.gate")


_DEFAULT_SESSION_KEY: Final[str] = "default"


class DeepGate:
    """Process-local per-session lock registry.

    Usage::

        gate = DeepGate.for_session(session_key)
        if gate.locked():
            # Reject — surface a clarification block to the user.
            ...
        else:
            async with gate:
                # Deep stages run here; a second caller for the same
                # session sees ``gate.locked() is True``.
                ...

    The lock is created lazily on first access for a given session
    key; callers that only want to inspect state should use
    :meth:`is_busy` which does NOT materialize a lock.
    """

    # Keyed by whatever ``session_key`` the caller supplies. In the
    # pipeline path we use ``safe_context["session_id"]`` coerced to
    # str; tests supply arbitrary strings.
    _locks: dict[str, asyncio.Lock] = {}

    @classmethod
    def for_session(cls, session_key: str | None) -> asyncio.Lock:
        """Return the ``asyncio.Lock`` for ``session_key``, creating it if needed.

        ``None`` / empty is coerced to a stable sentinel so the early
        dev path (no session plumbing yet) still gets one shared lock
        rather than a fresh ungated one per call.
        """
        key = _coerce_key(session_key)
        lock = cls._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            cls._locks[key] = lock
        return lock

    @classmethod
    def is_busy(cls, session_key: str | None) -> bool:
        """True when the session already has a deep turn running.

        Read-only — does NOT materialize a lock for the key if none
        exists yet. Used by the runner's fast-path rejection so the
        clarification branch never accidentally creates new locks.
        """
        key = _coerce_key(session_key)
        lock = cls._locks.get(key)
        return lock is not None and lock.locked()

    @classmethod
    def reset(cls) -> None:
        """Drop every registered lock.

        Test-only hook. The production pipeline never calls this —
        locks persist for the lifetime of the process so a runaway
        deep turn cannot be bypassed by recreating the registry.
        """
        cls._locks.clear()


def _coerce_key(session_key: str | None) -> str:
    """Coerce arbitrary session-key values to a stable string."""
    if session_key is None:
        return _DEFAULT_SESSION_KEY
    key = str(session_key).strip()
    if not key:
        return _DEFAULT_SESSION_KEY
    return key


__all__ = ["DeepGate"]
