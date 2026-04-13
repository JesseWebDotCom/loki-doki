"""Local persistent notes and list backend."""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills._store import load_store, next_id, save_store

_DEFAULT = {"notes": [], "lists": {"grocery list": []}}


def _store() -> dict[str, Any]:
    return load_store("notes", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("notes", payload)


def create_note(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    store = _store()
    note = {"id": next_id(store["notes"], "note"), "title": str(params.get("title") or "Note"), "body": str(params.get("body") or payload.get("chunk_text") or "")}
    store["notes"].append(note)
    _save(store)
    return AdapterResult(output_text=f"Saved note '{note['title']}'.", success=True, mechanism_used="local_notes", data=note).to_payload()


def append_to_list(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    name = str(params.get("list_name") or "grocery list").lower()
    items = params.get("items") or []
    if isinstance(items, str):
        items = [part.strip() for part in items.split(",") if part.strip()]
    store = _store()
    store["lists"].setdefault(name, [])
    store["lists"][name].extend(items)
    _save(store)
    return AdapterResult(output_text=f"Added {', '.join(items)} to {name}.", success=True, mechanism_used="local_lists", data={"list_name": name, "items": store['lists'][name]}).to_payload()


def read_list(payload: dict[str, Any]) -> dict[str, Any]:
    name = str((payload.get("params") or {}).get("list_name") or "grocery list").lower()
    items = _store()["lists"].get(name, [])
    if not items:
        return AdapterResult(output_text=f"{name.title()} is empty.", success=True).to_payload()
    return AdapterResult(output_text=f"{name.title()}: {', '.join(items)}.", success=True, data={"list_name": name, "items": items}).to_payload()


def search_notes(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").lower()
    notes = [item for item in _store()["notes"] if query in item["title"].lower() or query in item["body"].lower()]
    if not notes:
        return AdapterResult(output_text="I couldn't find any matching notes.", success=True).to_payload()
    preview = " | ".join(f"{item['title']}: {item['body']}" for item in notes[:5])
    return AdapterResult(output_text=f"Notes: {preview}.", success=True, data={"notes": notes[:5]}).to_payload()
