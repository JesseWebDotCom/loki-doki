"""Response adapter for unit conversions."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput


class UnitConversionAdapter:
    skill_id = "unit_conversion"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        value = data.get("value")
        from_unit = str(data.get("from_unit") or "").strip()
        output_value = data.get("result")
        to_unit = str(data.get("to_unit") or "").strip()
        if value is None or output_value is None or not from_unit or not to_unit:
            return AdapterOutput(raw=data)
        summary = f"{value} {from_unit} = {output_value} {to_unit}"
        return AdapterOutput(summary_candidates=(summary,), raw=data)
