"""Response adapter for the smarthome_mock skill.

The mock smart-home skill returns either a device status record or an
action confirmation. Both are local operations (no remote sources), so
the adapter emits only a summary candidate + a compact fact list.
"""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput


class SmartHomeMockAdapter:
    skill_id = "smarthome_mock"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        name = str(data.get("name") or "").strip()
        state = str(data.get("state") or "").strip()
        action = str(data.get("action") or "").strip()
        device_id = str(data.get("device_id") or "").strip()

        if not name and not state and not action:
            return AdapterOutput(raw=data)

        display_name = name or device_id or "Device"

        if action:
            summary = f"{display_name}: {action} → {state}" if state else f"{display_name}: {action}"
        else:
            summary = f"{display_name} is {state}" if state else display_name

        facts: list[str] = []
        if state:
            facts.append(f"State: {state}")
        brightness = data.get("brightness")
        if brightness is not None:
            facts.append(f"Brightness: {brightness}")
        temperature = data.get("temperature")
        if temperature is not None:
            facts.append(f"Temperature: {temperature}")
        dev_type = str(data.get("type") or "").strip()
        if dev_type:
            facts.append(f"Type: {dev_type}")

        return AdapterOutput(
            summary_candidates=(summary,),
            facts=tuple(facts),
            raw=data,
        )
