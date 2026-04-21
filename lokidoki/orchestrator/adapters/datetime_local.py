"""Response adapter for local date/time results."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput


class DateTimeAdapter:
    skill_id = "datetime_local"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        lead = str(data.get("lead") or "").strip()
        iso_value = str(data.get("datetime") or "").strip()
        timezone = str(data.get("timezone") or "").strip()
        if not lead and not iso_value:
            return AdapterOutput(raw=data)
        facts = tuple(
            value for value in (iso_value, timezone) if value
        )
        summary = (lead,) if lead else ()
        return AdapterOutput(summary_candidates=summary, facts=facts, raw=data)
