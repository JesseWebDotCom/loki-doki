"""Response adapter for calculator results."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput


class CalculatorAdapter:
    skill_id = "calculator"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        value = data.get("result")
        if value is None:
            return AdapterOutput(raw=data)
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        expression = str(data.get("expression") or "").strip()
        summary = f"{expression} = {value}" if expression else str(value)
        return AdapterOutput(summary_candidates=(summary,), raw=data)
