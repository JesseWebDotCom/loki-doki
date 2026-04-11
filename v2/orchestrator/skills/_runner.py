"""Shared mechanism-runner used by every v1 skill adapter.

The v1 ``BaseSkill.execute_mechanism`` contract returns a typed
``MechanismResult`` and the v1 orchestrator walks a manifest-driven
mechanism list in priority order. The v2 prototype does not load
manifests, so each adapter passes its own (method, parameters) tuples to
``run_mechanisms`` and gets back the first successful result, or a
graceful failure shape when every mechanism failed.

Keeping this logic in one place means individual adapters stay tiny and
the fallback semantics (try API → try cache → degrade) are consistent.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

log = logging.getLogger("v2.skills")


@dataclass(slots=True)
class AdapterResult:
    """v2-shaped result returned by every skill adapter.

    ``output_text`` is the only field the executor / combiner consumes;
    everything else is preserved on the result blob so the trace, the Dev
    Tools panel, and the Gemma fallback prompt can see provenance.
    """

    output_text: str
    success: bool = True
    mechanism_used: str = ""
    source_url: str = ""
    source_title: str = ""
    data: dict[str, Any] | None = None
    error: str = ""

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"output_text": self.output_text}
        if self.mechanism_used:
            payload["mechanism_used"] = self.mechanism_used
        if self.source_url:
            payload["source_url"] = self.source_url
        if self.source_title:
            payload["source_title"] = self.source_title
        if self.data is not None:
            payload["data"] = self.data
        if not self.success:
            payload["success"] = False
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
            return AdapterResult(
                output_text=output_text,
                success=True,
                mechanism_used=method,
                source_url=result.source_url,
                source_title=result.source_title,
                data=result.data,
            )
        last_error = result.error or last_error
    return AdapterResult(
        output_text=on_all_failed,
        success=False,
        mechanism_used=last_method,
        error=last_error,
    )


# Re-exported for adapters that want to construct AdapterResult directly
# (e.g. when the v1 skill returned success but the data is empty).
__all__ = ["AdapterResult", "run_mechanisms"]
