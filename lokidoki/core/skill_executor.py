import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


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
    mechanism_used: str | None = None
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
    """Executes skills with prioritized mechanism fallback and timeouts."""

    async def execute_skill(
        self,
        skill: BaseSkill,
        mechanisms: list[dict],
        parameters: dict,
    ) -> SkillResult:
        """Execute a skill trying mechanisms in priority order.

        Each mechanism has a timeout. On failure, falls through to the next.
        First successful mechanism wins.
        """
        sorted_mechs = sorted(mechanisms, key=lambda m: m.get("priority", 999))
        log: list[dict] = []
        t0 = time.perf_counter()

        for mech in sorted_mechs:
            method = mech["method"]
            timeout_s = mech.get("timeout_ms", 5000) / 1000.0
            entry = {"method": method, "status": "pending", "error": ""}

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
            except asyncio.TimeoutError:
                entry["status"] = "timed_out"
                entry["error"] = f"Timed out after {mech.get('timeout_ms', 5000)}ms"
            except Exception as e:
                entry["status"] = "error"
                entry["error"] = str(e)

            log.append(entry)

        return SkillResult(
            success=False,
            mechanism_log=log,
            latency_ms=(time.perf_counter() - t0) * 1000,
        )

    async def execute_parallel(
        self,
        tasks: list[tuple[str, BaseSkill, list[dict], dict]],
    ) -> dict[str, SkillResult]:
        """Execute multiple skills in parallel. Returns {ask_id: SkillResult}."""

        async def _run(ask_id: str, skill: BaseSkill, mechs: list[dict], params: dict):
            result = await self.execute_skill(skill, mechs, params)
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
