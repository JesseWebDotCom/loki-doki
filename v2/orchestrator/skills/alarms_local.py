"""Local persistent alarms, timers, and reminders backend."""
from __future__ import annotations

import re
from typing import Any

from v2.orchestrator.skills._runner import AdapterResult
from v2.orchestrator.skills._store import load_store, next_id, save_store

_DEFAULT = {"alarms": [], "timers": [], "reminders": []}


def _store() -> dict[str, Any]:
    return load_store("alarms", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("alarms", payload)


def _parse_time(text: str) -> str | None:
    match = re.search(r"\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b", text.lower())
    return match.group(1).upper() if match else None


def _parse_duration(text: str) -> str | None:
    match = re.search(r"\b(\d+\s*(?:minute|minutes|hour|hours|second|seconds))\b", text.lower())
    return match.group(1) if match else None


def set_alarm(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    when = params.get("time") or _parse_time(text)
    if not when:
        return AdapterResult(output_text="Tell me what time to set the alarm for.", success=False, error="missing time").to_payload()
    store = _store()
    alarm = {"id": next_id(store["alarms"], "alarm"), "time": when, "label": params.get("label"), "recurrence": params.get("recurrence")}
    store["alarms"].append(alarm)
    _save(store)
    return AdapterResult(output_text=f"Alarm set for {when}.", success=True, mechanism_used="local_alarm", data=alarm).to_payload()


def set_timer(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    duration = params.get("duration") or _parse_duration(text)
    if not duration:
        return AdapterResult(output_text="Tell me how long to set the timer for.", success=False, error="missing duration").to_payload()
    store = _store()
    timer = {"id": next_id(store["timers"], "timer"), "duration": duration, "label": params.get("label")}
    store["timers"].append(timer)
    _save(store)
    return AdapterResult(output_text=f"Timer set for {duration}.", success=True, mechanism_used="local_timer", data=timer).to_payload()


def set_reminder(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    reminder = {
        "id": next_id(_store()["reminders"], "reminder"),
        "text": str(params.get("text") or text).strip(),
        "time_or_event": params.get("time_or_event") or _parse_time(text) or _parse_duration(text),
    }
    store = _store()
    store["reminders"].append(reminder)
    _save(store)
    return AdapterResult(output_text=f"Reminder saved: {reminder['text']}.", success=True, mechanism_used="local_reminder", data=reminder).to_payload()


def cancel_alarm(payload: dict[str, Any]) -> dict[str, Any]:
    target = str((payload.get("params") or {}).get("id_or_label") or payload.get("chunk_text") or "").lower()
    store = _store()
    original = len(store["alarms"])
    store["alarms"] = [item for item in store["alarms"] if target not in {str(item["id"]).lower(), str(item.get("label") or "").lower(), str(item["time"]).lower()}]
    if len(store["alarms"]) == original:
        return AdapterResult(output_text="I couldn't find that alarm.", success=False, error="missing alarm").to_payload()
    _save(store)
    return AdapterResult(output_text="Alarm cancelled.", success=True, mechanism_used="local_alarm").to_payload()


def list_alarms(payload: dict[str, Any]) -> dict[str, Any]:
    alarms = _store()["alarms"]
    if not alarms:
        return AdapterResult(output_text="You don't have any alarms set.", success=True).to_payload()
    preview = " | ".join(f"{item['id']}: {item['time']}" + (f" ({item['label']})" if item.get("label") else "") for item in alarms)
    return AdapterResult(output_text=f"Alarms: {preview}.", success=True, data={"alarms": alarms}).to_payload()
