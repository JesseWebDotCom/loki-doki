"""time-until adapter for dates and named holidays."""
from __future__ import annotations

from datetime import date, datetime
import re
from typing import Any

from lokidoki.orchestrator.skills import holidays as holiday_skill
from lokidoki.orchestrator.skills._runner import AdapterResult

_MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


def _clean_target(text: str) -> str:
    value = text.lower().strip(" ?.!")
    for prefix in ("how long until ", "time until ", "days until ", "how many days until "):
        if value.startswith(prefix):
            return value[len(prefix):].strip()
    return value


def _parse_date_target(raw: str) -> date | None:
    value = _clean_target(raw)
    iso_match = re.search(r"\b(20\d{2})-(\d{2})-(\d{2})\b", value)
    if iso_match:
        return date(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
    month_day = re.search(r"\b([a-z]+)\s+(\d{1,2})(?:,\s*(20\d{2}))?\b", value)
    if not month_day:
        return None
    month = _MONTHS.get(month_day.group(1))
    if month is None:
        return None
    day_value = int(month_day.group(2))
    year = int(month_day.group(3)) if month_day.group(3) else date.today().year
    return date(year, month, day_value)


async def _resolve_named_holiday(target: str) -> tuple[str, date] | None:
    today = date.today()
    for year in (today.year, today.year + 1):
        payload = await holiday_skill.get_holiday(
            {"chunk_text": target, "params": {"name": target, "country": "US", "year": year}}
        )
        holiday = ((payload.get("data") or {}).get("holiday")) if isinstance(payload, dict) else None
        if not holiday or not holiday.get("date"):
            continue
        resolved = datetime.strptime(holiday["date"], "%Y-%m-%d").date()
        if resolved >= today:
            return str(holiday.get("name") or target), resolved
    return None


def _describe_delta(target_name: str, target_date: date) -> dict[str, Any]:
    today = date.today()
    delta_days = (target_date - today).days
    if delta_days < 0:
        return {
            "output_text": f"{target_name} was {-delta_days} days ago on {target_date.isoformat()}.",
            "success": True,
            "data": {"target": target_name, "date": target_date.isoformat(), "days": delta_days},
        }
    if delta_days == 0:
        return {
            "output_text": f"{target_name} is today.",
            "success": True,
            "data": {"target": target_name, "date": target_date.isoformat(), "days": 0},
        }
    return {
        "output_text": f"{target_name} is in {delta_days} days on {target_date.isoformat()}.",
        "success": True,
        "data": {"target": target_name, "date": target_date.isoformat(), "days": delta_days},
    }


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    text = str((payload.get("params") or {}).get("target") or payload.get("chunk_text") or "")
    direct_date = _parse_date_target(text)
    if direct_date is not None:
        return AdapterResult(**_describe_delta(direct_date.isoformat(), direct_date)).to_payload()
    holiday = await _resolve_named_holiday(_clean_target(text))
    if holiday is not None:
        name, target_date = holiday
        return AdapterResult(**_describe_delta(name, target_date)).to_payload()
    return AdapterResult(
        output_text="I couldn't figure out the target date for that countdown.",
        success=False,
        error="unknown target",
    ).to_payload()


__all__ = ["handle"]
