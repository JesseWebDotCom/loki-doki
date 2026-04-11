"""Local workout log and summary backend."""
from __future__ import annotations

import re
from typing import Any

from v2.orchestrator.skills._runner import AdapterResult
from v2.orchestrator.skills._store import load_store, next_id, save_store

_DEFAULT = {"workouts": []}


def _store() -> dict[str, Any]:
    return load_store("fitness", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("fitness", payload)


def log_workout(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("chunk_text") or "")
    params = payload.get("params") or {}
    match = re.search(r"(\d+)\s*(minute|minutes|hour|hours)", text.lower())
    duration = params.get("duration") or (match.group(0) if match else None)
    workout = {"id": next_id(_store()["workouts"], "workout"), "type": str(params.get("type") or text), "duration": duration, "notes": params.get("notes")}
    store = _store()
    store["workouts"].append(workout)
    _save(store)
    return AdapterResult(output_text=f"Logged workout: {workout['type']}.", success=True, mechanism_used="local_fitness", data=workout).to_payload()


def get_fitness_summary(payload: dict[str, Any]) -> dict[str, Any]:
    workouts = _store()["workouts"]
    if not workouts:
        return AdapterResult(output_text="You haven't logged any workouts yet.", success=True).to_payload()
    preview = " | ".join(
        f"{item['type']}" + (f" ({item['duration']})" if item.get("duration") else "")
        for item in workouts[-5:]
    )
    return AdapterResult(output_text=f"Recent workouts: {preview}. Total logged: {len(workouts)}.", success=True, data={"workouts": workouts[-5:]}).to_payload()
