"""v2 calculator adapter — wraps lokidoki.skills.calculator.

The v2 fast lane already handles trivial math utterances. This adapter
covers the routed path: a math chunk that arrives inside a compound
utterance and bypasses the fast lane. We hand the entire chunk text to
the v1 skill's ``safe_eval`` mechanism, which already does friendly
normalization (word operators → symbols, "X% of Y" → "(X/100)*Y").
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.calculator.skill import CalculatorSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = CalculatorSkill()


def _format_success(result, method: str) -> str:
    data = result.data or {}
    value = data.get("result")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value)


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    expression = (payload.get("params") or {}).get("expression") or payload.get("chunk_text") or ""
    if not expression:
        return AdapterResult(
            output_text="What would you like me to calculate?",
            success=False,
            error="missing expression",
        ).to_payload()
    attempts = [("safe_eval", {"expression": expression})]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed="I couldn't parse that expression.",
    )
    return result.to_payload()
