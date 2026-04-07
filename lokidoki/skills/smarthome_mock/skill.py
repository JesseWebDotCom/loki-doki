import copy
import json
import os
from typing import Optional, Tuple, Dict
from lokidoki.core.skill_executor import BaseSkill, MechanismResult

DEFAULT_DEVICES = {
    "living_room_light": {"name": "Living Room Light", "type": "light", "state": "off", "brightness": 100},
    "bedroom_light": {"name": "Bedroom Light", "type": "light", "state": "off", "brightness": 80},
    "reading_lamp": {"name": "Reading Lamp", "type": "light", "state": "on", "brightness": 60},
    "thermostat": {"name": "Thermostat", "type": "climate", "state": "on", "temperature": 22},
    "front_door_lock": {"name": "Front Door Lock", "type": "lock", "state": "locked"},
    "garage_door": {"name": "Garage Door", "type": "cover", "state": "closed"},
}

STATE_FILE = "data/smarthome_state.json"


class SmartHomeMockSkill(BaseSkill):
    """Mock smart home controller using local JSON state.

    Simulates Home Assistant-style device control without actual hardware.
    Uses BM25 to match fuzzy device names from user queries.
    """

    def __init__(self, state_path: str = STATE_FILE):
        self._state_path = state_path
        self._devices = self._load_state()

    def _load_state(self) -> dict[str, dict]:
        if os.path.exists(self._state_path):
            try:
                with open(self._state_path, "r") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        return copy.deepcopy(DEFAULT_DEVICES)

    def _save_state(self) -> None:
        os.makedirs(os.path.dirname(self._state_path), exist_ok=True)
        with open(self._state_path, "w") as f:
            json.dump(self._devices, f, indent=2)

    def _find_device(self, query: str) -> Optional[Tuple[str, Dict]]:
        """Find a device by fuzzy name match."""
        query_lower = query.lower()
        # Exact id match
        if query_lower in self._devices:
            return query_lower, self._devices[query_lower]
        # Name match
        for dev_id, dev in self._devices.items():
            if query_lower in dev["name"].lower() or dev["name"].lower() in query_lower:
                return dev_id, dev
        # Token overlap match
        query_tokens = set(query_lower.split())
        best_id, best_score = None, 0
        for dev_id, dev in self._devices.items():
            name_tokens = set(dev["name"].lower().split())
            overlap = len(query_tokens & name_tokens)
            if overlap > best_score:
                best_score = overlap
                best_id = dev_id
        if best_id and best_score > 0:
            return best_id, self._devices[best_id]
        return None

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "local_state":
            raise ValueError(f"Unknown mechanism: {method}")

        device_query = parameters.get("device", "")
        action = parameters.get("action", "status")

        match = self._find_device(device_query)
        if not match:
            return MechanismResult(
                success=False,
                error=f"Device '{device_query}' not found. Available: {', '.join(d['name'] for d in self._devices.values())}",
            )

        dev_id, device = match

        if action == "status" or not action:
            return MechanismResult(
                success=True,
                data={"device_id": dev_id, **device},
            )

        # Apply action
        if action in ("on", "off"):
            device["state"] = action
        elif action == "toggle":
            device["state"] = "off" if device["state"] == "on" else "on"
        elif action in ("lock", "locked"):
            device["state"] = "locked"
        elif action in ("unlock", "unlocked"):
            device["state"] = "unlocked"
        elif action in ("open", "opened"):
            device["state"] = "open"
        elif action in ("close", "closed"):
            device["state"] = "closed"
        elif action.startswith("brightness:"):
            try:
                device["brightness"] = int(action.split(":")[1])
            except (ValueError, IndexError):
                return MechanismResult(success=False, error="Invalid brightness value")
        elif action.startswith("temp:"):
            try:
                device["temperature"] = float(action.split(":")[1])
            except (ValueError, IndexError):
                return MechanismResult(success=False, error="Invalid temperature value")
        else:
            return MechanismResult(success=False, error=f"Unknown action: {action}")

        self._devices[dev_id] = device
        self._save_state()

        return MechanismResult(
            success=True,
            data={"device_id": dev_id, "action": action, **device},
        )
