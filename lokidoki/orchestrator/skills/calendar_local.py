"""Local persistent calendar backend for the pipeline."""
from __future__ import annotations

from datetime import date
import re
from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills._store import load_store, next_id, save_store

_DEFAULT = {"events": []}


def _store() -> dict[str, Any]:
    return load_store("calendar", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("calendar", payload)


def _parse_title(text: str) -> str:
    lower = text.lower().strip()
    for prefix in ("add ", "create ", "schedule ", "put ", "cancel ", "delete "):
        if lower.startswith(prefix):
            return text[len(prefix):].strip().title()
    return text.strip().title() or "Untitled Event"


def _parse_date(text: str) -> str:
    match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", text)
    if match:
        return match.group(1)
    lower = text.lower()
    if "tomorrow" in lower:
        return str(date.today().fromordinal(date.today().toordinal() + 1))
    return str(date.today())


def _parse_time(text: str) -> str | None:
    match = re.search(r"\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b", text.lower())
    return match.group(1).upper() if match else None


def create_event(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "")
    store = _store()
    event = {
        "id": next_id(store["events"], "event"),
        "title": str(params.get("title") or _parse_title(text)),
        "date": str(params.get("date") or _parse_date(text)),
        "time": params.get("time") or _parse_time(text),
        "duration": params.get("duration"),
        "notes": params.get("notes"),
    }
    store["events"].append(event)
    _save(store)
    when = f"{event['date']} {event['time']}".strip()
    return AdapterResult(
        output_text=f"Created event '{event['title']}' for {when}.",
        success=True,
        mechanism_used="local_calendar",
        data=event,
    ).to_payload()


def get_events(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "").lower()
    store = _store()
    events = store["events"]
    if params.get("range") == "today" or "today" in text:
        today = str(date.today())
        events = [item for item in events if item.get("date") == today]
    if not events:
        return AdapterResult(output_text="You don't have any matching calendar events.", success=True).to_payload()
    preview = " | ".join(
        f"{item['id']}: {item['title']} on {item['date']}" + (f" {item['time']}" if item.get("time") else "")
        for item in events[:5]
    )
    return AdapterResult(output_text=f"Calendar: {preview}.", success=True, data={"events": events}).to_payload()


def update_event(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    target = str(params.get("id") or params.get("title") or "").lower()
    if not target:
        return AdapterResult(output_text="Tell me which event to update.", success=False, error="missing event").to_payload()
    store = _store()
    for item in store["events"]:
        if target in {str(item["id"]).lower(), str(item["title"]).lower()}:
            for key in ("title", "date", "time", "duration", "notes"):
                if params.get(key) is not None:
                    item[key] = params[key]
            _save(store)
            return AdapterResult(
                output_text=f"Updated event '{item['title']}'.",
                success=True,
                mechanism_used="local_calendar",
                data=item,
            ).to_payload()
    return AdapterResult(output_text="I couldn't find that event.", success=False, error="missing event").to_payload()


def delete_event(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    target = str(params.get("id") or params.get("title") or payload.get("resolved_target") or "").lower()
    if not target:
        return AdapterResult(output_text="Tell me which event to delete.", success=False, error="missing event").to_payload()
    store = _store()
    kept = [item for item in store["events"] if target not in {str(item["id"]).lower(), str(item["title"]).lower()}]
    if len(kept) == len(store["events"]):
        return AdapterResult(output_text="I couldn't find that event.", success=False, error="missing event").to_payload()
    store["events"] = kept
    _save(store)
    return AdapterResult(output_text="Deleted the event.", success=True, mechanism_used="local_calendar").to_payload()
