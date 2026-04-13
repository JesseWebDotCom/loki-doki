"""Shared mechanism-runner used by every v1 skill adapter.

The v1 ``BaseSkill.execute_mechanism`` contract returns a typed
``MechanismResult`` and the v1 orchestrator walks a manifest-driven
mechanism list in priority order. The v2 prototype does not load
manifests, so each adapter passes its own (method, parameters) tuples to
``run_mechanisms`` and gets back the first successful result, or a
graceful failure shape when every mechanism failed.

Keeping this logic in one place means individual adapters stay tiny and
the fallback semantics (try API → try cache → degrade) are consistent.

Two runner shapes are exposed:

- ``run_mechanisms`` — sequential waterfall on one skill, first success
  wins. Used by most adapters (weather, units, etc.).
- ``run_sources_parallel_scored`` — fan out N independent source
  coroutines concurrently, score each success, return the highest-
  scoring result. Used when multiple independent sources (Wikipedia
  vs web search) might each be authoritative on different topics and
  the caller needs the best answer rather than the first one.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Iterable

from lokidoki.core.skill_executor import BaseSkill, MechanismResult
from v2.orchestrator.execution.errors import ErrorKind

log = logging.getLogger("v2.skills")


@dataclass(slots=True)
class AdapterResult:
    """v2-shaped result returned by every skill adapter.

    ``output_text`` is the only field the executor / combiner consumes;
    everything else is preserved on the result blob so the trace, the Dev
    Tools panel, and the LLM fallback prompt can see provenance.
    """

    output_text: str
    success: bool = True
    error_kind: ErrorKind = ErrorKind.none
    mechanism_used: str = ""
    source_url: str = ""
    source_title: str = ""
    data: dict[str, Any] | None = None
    sources: list[dict[str, str]] = field(default_factory=list)
    error: str = ""

    def to_payload(self) -> dict[str, Any]:
        # Auto-populate sources from source_url/source_title when the
        # skill set those fields but didn't build the sources list
        # itself. This covers direct-API skills (markets, people_facts)
        # that set source_url but don't use run_mechanisms.
        sources = list(self.sources)
        if not sources and self.source_url:
            sources.append({
                "url": self.source_url,
                "title": self.source_title or self.source_url,
            })
        payload: dict[str, Any] = {
            "output_text": self.output_text,
            "success": self.success,
            "error_kind": self.error_kind.value,
            "mechanism_used": self.mechanism_used,
            "data": self.data,
            "sources": sources,
        }
        if self.source_url:
            payload["source_url"] = self.source_url
        if self.source_title:
            payload["source_title"] = self.source_title
        if self.error:
            payload["error"] = self.error
        return payload


async def run_mechanisms(
    skill: BaseSkill,
    attempts: Iterable[tuple[str, dict[str, Any]]],
    *,
    on_success: "Callable[[MechanismResult, str], str]",
    on_all_failed: str,
) -> AdapterResult:
    """Run each (method, parameters) tuple in order until one succeeds.

    Parameters
    ----------
    skill:
        The v1 skill instance whose ``execute_mechanism`` we will call.
    attempts:
        Ordered iterable of ``(method_name, parameters_dict)`` tuples.
        First successful call wins.
    on_success:
        Callback that receives the successful ``MechanismResult`` plus
        the mechanism name and returns the user-facing ``output_text``.
        Adapters use this to format the v1 ``data`` blob into a
        deterministic short string.
    on_all_failed:
        ``output_text`` to return when every mechanism failed. Should
        be a graceful, non-blaming sentence the combiner can deliver
        directly to the user (e.g. "I couldn't reach the weather
        service right now.").
    """
    last_error = ""
    last_method = ""
    for method, params in attempts:
        last_method = method
        try:
            result = await skill.execute_mechanism(method, params)
        except Exception as exc:  # noqa: BLE001 - never let v1 leak crashes into v2
            log.warning("v2 skill adapter: %s.%s raised %s", type(skill).__name__, method, exc)
            last_error = str(exc)
            continue
        if result.success:
            try:
                output_text = on_success(result, method)
            except Exception as exc:  # noqa: BLE001
                log.exception("v2 skill adapter on_success formatter raised")
                last_error = str(exc)
                continue
            sources: list[dict[str, str]] = []
            if result.source_url:
                sources.append({
                    "url": result.source_url,
                    "title": result.source_title or result.source_url,
                })
            return AdapterResult(
                output_text=output_text,
                success=True,
                mechanism_used=method,
                source_url=result.source_url,
                source_title=result.source_title,
                data=result.data,
                sources=sources,
            )
        last_error = result.error or last_error
    return AdapterResult(
        output_text=on_all_failed,
        success=False,
        error_kind=ErrorKind.provider_down,
        mechanism_used=last_method,
        error=last_error,
    )


async def run_sources_parallel_scored(
    sources: list[tuple[str, Awaitable[AdapterResult]]],
    *,
    score: Callable[[AdapterResult], float],
    threshold: float,
    fallback_text: str,
) -> AdapterResult:
    """Fan out independent sources, score each success, return the winner.

    Each ``sources`` entry is ``(source_name, coroutine)`` where the
    coroutine eventually returns an :class:`AdapterResult`. The runner
    awaits all coroutines concurrently via :func:`asyncio.gather` so
    the wall-clock cost is roughly the slowest source, not the sum.

    For every successful result, ``score(result)`` is called to compute
    a float coverage score. Any candidate whose score is below
    ``threshold`` is treated as "off-subject" and discarded. Among the
    qualifying candidates, the one with the highest score wins; ties
    are broken by ``sources`` list order (earlier = preferred).

    If every source failed or every score was below ``threshold``, a
    failed :class:`AdapterResult` is returned with ``fallback_text``
    as the user-facing message. The full per-candidate breakdown
    (including scores and errors) is attached to ``data["candidates"]``
    on both the success and failure paths so downstream tracing /
    Dev Tools can show why a given source won or lost.
    """
    names = [name for name, _ in sources]
    coros = [coro for _, coro in sources]
    settled = await asyncio.gather(*coros, return_exceptions=True)

    candidates: list[dict[str, Any]] = []
    for name, outcome in zip(names, settled, strict=True):
        if isinstance(outcome, BaseException):
            log.warning("v2 parallel source %s raised %s", name, outcome)
            candidates.append(
                {
                    "source": name,
                    "success": False,
                    "score": 0.0,
                    "mechanism_used": "",
                    "error": str(outcome),
                }
            )
            continue
        result = outcome  # type: AdapterResult
        if not result.success:
            candidates.append(
                {
                    "source": name,
                    "success": False,
                    "score": 0.0,
                    "mechanism_used": result.mechanism_used,
                    "error": result.error,
                }
            )
            continue
        try:
            raw_score = float(score(result))
        except Exception as exc:  # noqa: BLE001 - scorer bugs must never crash the skill
            log.warning("v2 parallel source %s scoring raised %s", name, exc)
            raw_score = 0.0
        candidates.append(
            {
                "source": name,
                "success": True,
                "score": round(raw_score, 3),
                "mechanism_used": result.mechanism_used,
                "output_text": result.output_text,
                "source_url": result.source_url,
                "source_title": result.source_title,
                "_result": result,
            }
        )

    qualified = [
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate["success"] and candidate["score"] >= threshold
    ]

    # Strip the private ``_result`` pointer before exposing candidates
    # on the trace payload — it's only needed internally to pick the
    # winner and would otherwise leak a skill object into the JSON.
    def _clean(entry: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in entry.items() if k != "_result"}

    clean_candidates = [_clean(c) for c in candidates]

    if not qualified:
        return AdapterResult(
            output_text=fallback_text,
            success=False,
            error_kind=ErrorKind.no_data,
            mechanism_used="parallel",
            error="no qualifying sources",
            data={
                "candidates": clean_candidates,
                "threshold": threshold,
                "winner": None,
            },
        )

    # Sort by descending score; ties fall back to original source list
    # order (``index`` is stable and ascending), which is the caller's
    # preference order.
    qualified.sort(key=lambda item: (-item[1]["score"], item[0]))
    _, winner = qualified[0]
    winning_result: AdapterResult = winner["_result"]

    merged_data: dict[str, Any] = {}
    if winning_result.data:
        merged_data.update(winning_result.data)
    merged_data["candidates"] = clean_candidates
    merged_data["winner"] = winner["source"]
    merged_data["winner_score"] = winner["score"]
    merged_data["threshold"] = threshold

    # Propagate sources from the winner; fall back to source_url/title.
    sources = list(winning_result.sources)
    if not sources and winning_result.source_url:
        sources.append({
            "url": winning_result.source_url,
            "title": winning_result.source_title or winning_result.source_url,
        })

    return AdapterResult(
        output_text=winning_result.output_text,
        success=True,
        mechanism_used=winning_result.mechanism_used,
        source_url=winning_result.source_url,
        source_title=winning_result.source_title,
        data=merged_data,
        sources=sources,
    )


# Re-exported for adapters that want to construct AdapterResult directly
# (e.g. when the v1 skill returned success but the data is empty).
__all__ = ["AdapterResult", "ErrorKind", "run_mechanisms", "run_sources_parallel_scored"]
