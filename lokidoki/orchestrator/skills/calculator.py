"""calculator adapter — wraps lokidoki.skills.calculator.

The fast lane already handles trivial math utterances. This adapter
covers the routed path: a math chunk that arrives inside a compound
utterance and bypasses the fast lane. We hand the entire chunk text to
the skill's ``safe_eval`` mechanism, which already does friendly
normalization (word operators → symbols, "X% of Y" → "(X/100)*Y").
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.calculator.skill import CalculatorSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

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


def calculate_tip(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic tip calculator for billing-style requests."""
    text = str(payload.get("chunk_text") or "")
    lower = text.lower()
    amount_match = (
        re.search(r"tip on\s+\$?\s*(-?\d+(?:\.\d+)?)", lower)
        or re.search(r"on\s+\$?\s*(-?\d+(?:\.\d+)?)", lower)
        or re.search(r"\$\s*(-?\d+(?:\.\d+)?)", lower)
        or re.search(r"bill(?: of| is)?\s+\$?\s*(-?\d+(?:\.\d+)?)", lower)
    )
    pct_match = re.search(r"(\d+(?:\.\d+)?)\s*%", lower)
    split_match = re.search(r"split\s+(?:between\s+)?(\d+)", lower)
    if not amount_match:
        return AdapterResult(
            output_text="I couldn't find the bill amount for that tip calculation.",
            success=False,
            error="missing amount",
        ).to_payload()
    amount = float(amount_match.group(1))
    pct = float(pct_match.group(1)) if pct_match else 20.0
    split = int(split_match.group(1)) if split_match else 1
    tip = round(amount * pct / 100, 2)
    total = round(amount + tip, 2)
    per_person = round(total / split, 2)

    def _fmt(value: float) -> str:
        return f"{value:.2f}".rstrip("0").rstrip(".")

    suffix = f", or {_fmt(per_person)} each split {split} ways" if split > 1 else ""
    return AdapterResult(
        output_text=(
            f"{_fmt(pct)}% tip on {_fmt(amount)} is {_fmt(tip)}. "
            f"Total is {_fmt(total)}{suffix}."
        ),
        success=True,
        mechanism_used="local_tip_math",
        data={"amount": amount, "tip_pct": pct, "split": split, "tip": tip, "total": total},
    ).to_payload()
