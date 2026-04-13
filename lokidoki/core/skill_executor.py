import asyncio
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from lokidoki.core.skill_cache import (
    SkillResultCache,
    build_cache_key,
    resolve_cache_spec,
)

logger = logging.getLogger("lokidoki.core.skill_executor")


@dataclass
class MechanismResult:
    success: bool
    data: dict = field(default_factory=dict)
    error: str = ""
    source_url: str = ""
    source_title: str = ""


@dataclass
class SkillResult:
    success: bool
    data: dict = field(default_factory=dict)
    mechanism_used: str  = None
    mechanism_log: list[dict] = field(default_factory=list)
    source_url: str = ""
    source_title: str = ""
    latency_ms: float = 0.0


class BaseSkill(ABC):
    """Abstract base class for all LokiDoki skills."""

    @abstractmethod
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        """Execute a specific mechanism and return its result."""
        ...


class SkillExecutor:
    """Executes skills with prioritized mechanism fallback and timeouts.

    Optionally consults a ``SkillResultCache`` (passed at construction)
    to short-circuit mechanism calls when a fresh cached result exists.
    Caching is opt-in **per mechanism**: a manifest mechanism block
    must declare ``"cache": {"ttl": "until_local_midnight"}`` or
    ``"cache": {"ttl_s": N}`` for the executor to consider it. Without
    that, the cache is bypassed entirely. See ``skill_cache.py`` for
    the full TTL grammar and admin-override semantics.

    The executor passes ``parameters['_skill_id']`` (transient, stripped
    before the call) into key construction so a single physical
    instance shared across multiple manifests still gets isolated keys.
    """

    def __init__(self, cache: Optional[SkillResultCache] = None) -> None:
        self._cache = cache

    async def execute_skill(
        self,
        skill: BaseSkill,
        mechanisms: list[dict],
        parameters: dict,
        *,
        skill_id: str = "",
    ) -> SkillResult:
        """Execute a skill trying mechanisms in priority order.

        Each mechanism has a timeout. On failure, falls through to the next.
        First successful mechanism wins.

        When a ``SkillResultCache`` is wired in and the mechanism opts
        into caching via its manifest, a fresh hit short-circuits the
        live call entirely; HIT/MISS/STORE log lines mark each path so
        debugging "is this stale?" is a single grep.
        """
        sorted_mechs = sorted(mechanisms, key=lambda m: m.get("priority", 999))
        log: list[dict] = []
        t0 = time.perf_counter()
        merged_config = (parameters or {}).get("_config") or {}
        skip_cache = bool((parameters or {}).get("_skip_cache"))

        for mech in sorted_mechs:
            method = mech["method"]
            timeout_s = mech.get("timeout_ms", 5000) / 1000.0
            logger.debug(f"[Executor] Trying mechanism {method} for {skill_id} (timeout={timeout_s}s)")
            entry = {"method": method, "status": "pending", "error": ""}

            cache_spec = resolve_cache_spec(mech, merged_config)
            cache_key = (
                build_cache_key(skill_id or "", method, parameters)
                if (self._cache and skill_id and cache_spec.enabled and not skip_cache)
                else ""
            )

            # ---- Tier 0: cache hit short-circuit -----------------------
            if cache_key:
                hit = await self._cache.get(skill_id, method, cache_key)
                if hit is not None:
                    logger.info(
                        "[skill_cache] HIT skill=%s method=%s key=%s age=%ds",
                        skill_id, method, cache_key[:10], hit.age_seconds,
                    )
                    entry["status"] = "cache_hit"
                    log.append(entry)
                    return SkillResult(
                        success=True,
                        data=hit.data,
                        mechanism_used=hit.mechanism,
                        mechanism_log=log,
                        source_url=hit.source_url,
                        source_title=hit.source_title,
                        latency_ms=(time.perf_counter() - t0) * 1000,
                    )
                logger.info(
                    "[skill_cache] MISS skill=%s method=%s key=%s — fetching live",
                    skill_id, method, cache_key[:10],
                )

            try:
                result = await asyncio.wait_for(
                    skill.execute_mechanism(method, parameters),
                    timeout=timeout_s,
                )
                if isinstance(result, Exception):
                    raise result

                if result.success:
                    entry["status"] = "success"
                    log.append(entry)
                    # ---- Tier 1: write-through -------------------------
                    if cache_key:
                        expires_at = cache_spec.expires_at()
                        await self._cache.put(
                            skill_id=skill_id,
                            mechanism=method,
                            key=cache_key,
                            data=result.data,
                            source_url=result.source_url,
                            source_title=result.source_title,
                            expires_at=expires_at,
                        )
                        logger.info(
                            "[skill_cache] STORE skill=%s method=%s key=%s expires=%s",
                            skill_id, method, cache_key[:10],
                            expires_at.isoformat() if expires_at else "never",
                        )
                    return SkillResult(
                        success=True,
                        data=result.data,
                        mechanism_used=method,
                        mechanism_log=log,
                        source_url=result.source_url,
                        source_title=result.source_title,
                        latency_ms=(time.perf_counter() - t0) * 1000,
                    )
                else:
                    entry["status"] = "failed"
                    entry["error"] = result.error
                    logger.debug(f"[Executor] Mechanism {method} failed: {result.error}")
            except asyncio.TimeoutError:
                entry["status"] = "timed_out"
                entry["error"] = f"Timed out after {mech.get('timeout_ms', 5000)}ms"
            except Exception as e:
                entry["status"] = "error"
                entry["error"] = str(e)
                logger.debug(f"[Executor] Mechanism {method} crashed: {e}")

            log.append(entry)

        return SkillResult(
            success=False,
            mechanism_log=log,
            latency_ms=(time.perf_counter() - t0) * 1000,
        )

    async def execute_parallel(
        self,
        tasks: list[tuple[str, BaseSkill, list[dict], dict]],
        *,
        skill_ids: Optional[dict[str, str]] = None,
    ) -> dict[str, SkillResult]:
        """Execute multiple skills in parallel. Returns {ask_id: SkillResult}.

        ``skill_ids`` is an optional ``{ask_id: skill_id}`` map so the
        executor can look up the skill identifier for cache-key
        construction without changing the existing tuple shape (which
        is asserted by ~12 unit tests). When omitted the cache is
        bypassed for all parallel asks — same behavior as before.
        """
        sids = skill_ids or {}

        async def _run(ask_id: str, skill: BaseSkill, mechs: list[dict], params: dict):
            result = await self.execute_skill(
                skill, mechs, params, skill_id=sids.get(ask_id, ""),
            )
            return ask_id, result

        coros = [_run(aid, s, m, p) for aid, s, m, p in tasks]
        completed = await asyncio.gather(*coros, return_exceptions=True)

        results = {}
        for item in completed:
            if isinstance(item, Exception):
                continue
            ask_id, result = item
            results[ask_id] = result

        return results
