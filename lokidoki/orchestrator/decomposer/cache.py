"""Tiny in-memory cache for decomposer results.

Repeat user turns are common (retries after a timeout, follow-ups that
echo part of the prior input, and the same prompt re-issued via dev
tooling). Each uncached turn pays ~300-800ms for the LLM call; a cache
hit returns in microseconds.

The cache is intentionally small and short-lived — ``MAX_ENTRIES`` caps
memory, and ``TTL_S`` ensures the decomposer doesn't keep serving a
stale routing decision when the user's intent shifts between turns.
LRU-style eviction (oldest-inserted first) keeps lookups O(1).
"""
from __future__ import annotations

import time
from collections import OrderedDict

from lokidoki.orchestrator.decomposer.types import RouteDecomposition

# Cap at 256 entries so the cache itself can't grow unbounded on a
# long-running assistant session. 256 × ~200 bytes = ~50KB max.
MAX_ENTRIES: int = 256

# 5-minute TTL — long enough to absorb rapid retries + follow-ups,
# short enough that a drift in user intent evicts stale entries.
TTL_S: float = 300.0


class _DecomposerCache:
    """LRU-style cache keyed by (normalized_text, recent_context).

    Not thread-safe — but the decomposer only runs inside the async
    event loop, so single-threaded access is the norm.
    """

    def __init__(self, max_entries: int = MAX_ENTRIES, ttl_s: float = TTL_S) -> None:
        self._entries: OrderedDict[tuple[str, str], tuple[float, RouteDecomposition]] = OrderedDict()
        self._max = max_entries
        self._ttl = ttl_s

    def get(self, raw_text: str, recent_context: str) -> RouteDecomposition | None:
        """Return the cached decomposition for this input, or None if miss/expired."""
        key = self._key(raw_text, recent_context)
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, decomposition = entry
        if (time.monotonic() - stored_at) > self._ttl:
            # Stale — drop and miss
            self._entries.pop(key, None)
            return None
        # LRU bump — move to the end
        self._entries.move_to_end(key)
        return decomposition

    def put(
        self,
        raw_text: str,
        recent_context: str,
        decomposition: RouteDecomposition,
    ) -> None:
        """Store a decomposition, evicting the oldest entry if full.

        Non-authoritative results (timeout/error/disabled) are NOT
        cached — they were transient failures, retrying might succeed,
        and caching a failure would make recovery slower not faster.
        """
        if not decomposition.is_authoritative():
            return
        key = self._key(raw_text, recent_context)
        self._entries[key] = (time.monotonic(), decomposition)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max:
            self._entries.popitem(last=False)  # evict oldest

    def clear(self) -> None:
        """Drop every entry. Used by tests."""
        self._entries.clear()

    def size(self) -> int:
        return len(self._entries)

    @staticmethod
    def _key(raw_text: str, recent_context: str) -> tuple[str, str]:
        # Case-fold + collapse whitespace so "Hello   World" and "hello world"
        # share a cache entry. recent_context is included in the key since
        # pronoun resolution depends on it.
        return (
            " ".join(raw_text.lower().split()),
            " ".join((recent_context or "").lower().split()),
        )


_CACHE = _DecomposerCache()


def get_cached(raw_text: str, recent_context: str = "") -> RouteDecomposition | None:
    return _CACHE.get(raw_text, recent_context)


def put_cached(
    raw_text: str,
    recent_context: str,
    decomposition: RouteDecomposition,
) -> None:
    _CACHE.put(raw_text, recent_context, decomposition)


def clear_cache() -> None:
    _CACHE.clear()


def cache_size() -> int:
    return _CACHE.size()
