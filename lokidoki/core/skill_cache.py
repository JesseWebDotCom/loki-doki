"""Cross-skill result cache backed by SQLite.

The ``SkillExecutor`` consults this cache before invoking a mechanism
and writes successful results back after. Skills themselves are
unaware — they declare a default TTL in their manifest and the
executor handles the read/write/expiry plumbing transparently.

Why this lives in the executor and not in each skill
----------------------------------------------------
Before this module, ~15 skills had ad-hoc per-instance dicts that
"cached" results for the lifetime of the process. None of them
survived a restart, none had TTLs, and every author wrote a slightly
different version. Hoisting the cache into the executor:

  * unifies the implementation
  * makes the cache survive across restarts (Pi reboots, deploys)
  * lets the admin override TTLs from the settings UI without
    redeploying the skill
  * gives a single place to add observability (HIT/MISS/STORE logs,
    later: stats endpoints, manual flush controls)

TTL semantics
-------------
Two formats are supported in the manifest mechanism block:

  "cache": {"ttl_s": 3600}            # plain seconds-from-now
  "cache": {"ttl": "until_local_midnight"}

The second form is the *important* one for the use cases driving this
module — showtimes for today, weather forecast for today, news for
today. A plain "1 hour" TTL would happily serve a 23-hour-old forecast
at 11:30pm. Computing the next local midnight gives the right
semantics: cache the day's data on first pull, expire automatically
when the day rolls over.

Admin override
--------------
Each cache-using mechanism may also be controlled via a per-skill
config field declared in the manifest's ``config_schema`` (typically
named ``cache_ttl_override``). When set, the override wins over the
manifest default. This lets a user say "actually re-fetch movies
every 30 minutes" or "never cache" without touching code.
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger("lokidoki.core.skill_cache")


# ---- TTL parsing ----------------------------------------------------------


@dataclass
class CacheSpec:
    """Effective cache configuration for one mechanism call.

    ``ttl_s`` and ``ttl_keyword`` are mutually exclusive — exactly one
    is set when caching is enabled. ``None`` means caching is off for
    this call (no manifest declaration AND no admin override).
    """
    ttl_s: Optional[int] = None
    ttl_keyword: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self.ttl_s is not None or self.ttl_keyword is not None

    def expires_at(self, *, now: Optional[datetime] = None) -> Optional[datetime]:
        """Compute the absolute expiry instant for a write happening *now*.

        Returns ``None`` if caching is disabled. Times are returned in
        UTC so the SQLite ``datetime('now')`` comparison stays apples
        to apples — SQLite stores datetime() output in UTC by default.
        """
        if not self.enabled:
            return None
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if self.ttl_s is not None:
            return now + timedelta(seconds=int(self.ttl_s))
        if self.ttl_keyword == "until_local_midnight":
            # Compute next 00:00 in *system local* time, then convert to
            # UTC for storage. This is the semantic users actually want
            # for "today's" data: it expires when the calendar day rolls
            # over wherever the box physically lives, not at UTC midnight.
            local_now = now.astimezone()
            tomorrow_local = (local_now + timedelta(days=1)).date()
            midnight_local = datetime.combine(
                tomorrow_local, dtime.min, tzinfo=local_now.tzinfo,
            )
            return midnight_local.astimezone(timezone.utc)
        # Unknown keyword — fail open (no caching) rather than crash.
        logger.warning(
            "[skill_cache] unknown ttl keyword %r — caching disabled",
            self.ttl_keyword,
        )
        return None


def resolve_cache_spec(
    mechanism: dict, merged_config: Optional[dict]
) -> CacheSpec:
    """Combine manifest cache declaration + admin/user override.

    Precedence (highest first):
      1. ``merged_config["cache_ttl_override"]`` — per-user / per-admin
         override stored in ``skill_config_*`` tables. May be a number
         (seconds), the string "off" / "0" (disable), or one of the
         supported keywords ("until_local_midnight").
      2. ``mechanism["cache"]`` — declared by the skill author.
      3. nothing → caching disabled.

    The override is **always** keyed as ``cache_ttl_override`` so the
    settings UI doesn't need a per-skill schema dance — any skill that
    opts in just adds the same field to its config_schema.
    """
    override = (merged_config or {}).get("cache_ttl_override")
    if override is not None and override != "":
        if isinstance(override, str):
            ov = override.strip().lower()
            if ov in ("off", "no", "false", "0", "disabled"):
                return CacheSpec()
            if ov == "until_local_midnight":
                return CacheSpec(ttl_keyword="until_local_midnight")
            try:
                return CacheSpec(ttl_s=int(ov))
            except ValueError:
                logger.warning(
                    "[skill_cache] invalid cache_ttl_override=%r; using default",
                    override,
                )
        elif isinstance(override, (int, float)):
            return CacheSpec(ttl_s=int(override) if override > 0 else None) if override > 0 else CacheSpec()
    decl = (mechanism or {}).get("cache") or {}
    if isinstance(decl, dict):
        if "ttl_s" in decl and isinstance(decl["ttl_s"], (int, float)) and decl["ttl_s"] > 0:
            return CacheSpec(ttl_s=int(decl["ttl_s"]))
        if "ttl" in decl and isinstance(decl["ttl"], str):
            kw = decl["ttl"].strip().lower()
            if kw == "until_local_midnight":
                return CacheSpec(ttl_keyword=kw)
            try:
                return CacheSpec(ttl_s=int(kw))
            except ValueError:
                pass
    return CacheSpec()


# ---- Key construction -----------------------------------------------------


# Parameter keys that must NOT contribute to the cache key. ``_config``
# carries secrets and per-user state; ``_skip_cache`` is a request-time
# bypass flag, not a data input. Anything else is fair game — even
# nominally redundant fields like ``date`` SHOULD be in the key because
# they pick a different slice of the underlying data.
_CACHE_KEY_EXCLUDED_PARAMS = {"_config", "_skip_cache"}


def _canonicalize(value: Any) -> Any:
    """Return a JSON-stable shape for ``value``.

    Sorts dict keys recursively so two semantically-identical params
    dicts (``{"a":1,"b":2}`` and ``{"b":2,"a":1}``) hash to the same
    cache key. Filters non-JSON-serializable values to a string repr —
    we'd rather pollute the key than crash mid-cache-write.
    """
    if isinstance(value, dict):
        return {k: _canonicalize(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_canonicalize(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def build_cache_key(skill_id: str, mechanism: str, parameters: dict) -> str:
    """Hash ``(skill, mechanism, params)`` into a stable cache key.

    sha1 is fine here — this is a content-addressed lookup, not a
    cryptographic boundary, and 40 hex chars fits comfortably in a
    SQLite TEXT primary key. The order of keys in ``parameters`` does
    NOT matter (see ``_canonicalize``).
    """
    filtered = {
        k: v for k, v in (parameters or {}).items()
        if k not in _CACHE_KEY_EXCLUDED_PARAMS
    }
    payload = json.dumps(
        {"s": skill_id, "m": mechanism, "p": _canonicalize(filtered)},
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


# ---- Storage --------------------------------------------------------------


@dataclass
class CachedEntry:
    """A successful past mechanism call resurrected from the cache."""
    data: dict
    source_url: str
    source_title: str
    mechanism: str
    age_seconds: int


class SkillResultCache:
    """Async-friendly façade over the ``skill_result_cache`` SQLite table.

    Wraps the existing ``MemoryProvider.run_sync`` pattern so callers
    don't have to think about thread-pool dispatch. The provider is
    optional — when ``memory`` is None the cache silently no-ops, which
    is what unit tests of the executor want when they don't care about
    cache behavior.
    """

    def __init__(self, memory: Any) -> None:
        self._memory = memory

    async def get(
        self, skill_id: str, mechanism: str, key: str
    ) -> Optional[CachedEntry]:
        if self._memory is None:
            return None

        def _read(conn: sqlite3.Connection) -> Optional[CachedEntry]:
            row = conn.execute(
                "SELECT value, cached_meta, created_at, expires_at "
                "FROM skill_result_cache "
                "WHERE cache_key = ? "
                "  AND (expires_at IS NULL OR expires_at > datetime('now'))",
                (key,),
            ).fetchone()
            if not row:
                return None
            try:
                data = json.loads(row["value"])
            except (TypeError, json.JSONDecodeError):
                return None
            try:
                meta = json.loads(row["cached_meta"] or "{}")
            except (TypeError, json.JSONDecodeError):
                meta = {}
            # Compute age in seconds for the log line; SQLite stores
            # created_at in UTC ISO so parse + diff in UTC.
            age = 0
            try:
                created = datetime.fromisoformat(row["created_at"]).replace(tzinfo=timezone.utc)
                age = int((datetime.now(timezone.utc) - created).total_seconds())
            except Exception:  # noqa: BLE001
                pass
            return CachedEntry(
                data=data,
                source_url=meta.get("source_url", ""),
                source_title=meta.get("source_title", ""),
                mechanism=meta.get("mechanism") or mechanism,
                age_seconds=age,
            )

        try:
            return await self._memory.run_sync(_read)
        except Exception as e:  # noqa: BLE001
            logger.warning("[skill_cache] read failed for %s: %s", key, e)
            return None

    async def put(
        self,
        *,
        skill_id: str,
        mechanism: str,
        key: str,
        data: dict,
        source_url: str,
        source_title: str,
        expires_at: Optional[datetime],
    ) -> None:
        if self._memory is None:
            return
        try:
            value = json.dumps(data, default=str)
        except (TypeError, ValueError) as e:
            logger.warning(
                "[skill_cache] skipping unserializable result for %s.%s: %s",
                skill_id, mechanism, e,
            )
            return
        meta = json.dumps({
            "source_url": source_url,
            "source_title": source_title,
            "mechanism": mechanism,
        })
        expires_iso = (
            expires_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            if expires_at else None
        )

        def _write(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO skill_result_cache "
                "  (cache_key, skill_id, mechanism, value, cached_meta, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(cache_key) DO UPDATE SET "
                "  value = excluded.value, "
                "  cached_meta = excluded.cached_meta, "
                "  expires_at = excluded.expires_at, "
                "  created_at = datetime('now')",
                (key, skill_id, mechanism, value, meta, expires_iso),
            )
            conn.commit()

        try:
            await self._memory.run_sync(_write)
        except Exception as e:  # noqa: BLE001
            logger.warning("[skill_cache] write failed for %s: %s", key, e)

    async def invalidate_skill(self, skill_id: str) -> int:
        """Wipe every cached row for a single skill. Returns row count."""
        if self._memory is None:
            return 0

        def _wipe(conn: sqlite3.Connection) -> int:
            cur = conn.execute(
                "DELETE FROM skill_result_cache WHERE skill_id = ?",
                (skill_id,),
            )
            conn.commit()
            return cur.rowcount

        try:
            return await self._memory.run_sync(_wipe)
        except Exception as e:  # noqa: BLE001
            logger.warning("[skill_cache] invalidate failed for %s: %s", skill_id, e)
            return 0
