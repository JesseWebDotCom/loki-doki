from datetime import datetime, timezone as tz
from zoneinfo import ZoneInfo

from lokidoki.core.skill_executor import BaseSkill, MechanismResult


class DateTimeSkill(BaseSkill):
    """Returns current date/time from the system clock."""

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "system_clock":
            raise ValueError(f"Unknown mechanism: {method}")

        tz_name = parameters.get("timezone")
        try:
            if tz_name:
                zone = ZoneInfo(tz_name)
            else:
                zone = None  # local time
        except (KeyError, Exception):
            zone = None  # fall back to local

        now = datetime.now(zone)
        return MechanismResult(
            success=True,
            data={
                "datetime": now.isoformat(),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M:%S"),
                "timezone": str(now.tzinfo) if now.tzinfo else "local",
                "day_of_week": now.strftime("%A"),
            },
        )
