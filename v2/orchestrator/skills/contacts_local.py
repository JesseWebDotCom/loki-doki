"""Local persistent contacts, messaging, call log, and email inbox backend."""
from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from v2.orchestrator.skills._runner import AdapterResult
from v2.orchestrator.skills._store import load_store, next_id, save_store

_DEFAULT = {
    "contacts": [
        {"id": "contact_001", "name": "Leia", "phone": "555-0101", "email": "leia@example.com"},
        {"id": "contact_002", "name": "Luke", "phone": "555-0102", "email": "luke@example.com"},
        {"id": "contact_003", "name": "Anakin", "phone": "555-0103", "email": "anakin@example.com"},
    ],
    "messages": [],
    "emails": [
        {"id": "email_001", "from": "Leia", "subject": "Project update", "folder": "inbox", "body": "Status looks good.", "received_at": "2026-04-11T08:00:00"},
        {"id": "email_002", "from": "Luke", "subject": "Dinner plans", "folder": "inbox", "body": "Want to grab dinner?", "received_at": "2026-04-11T09:00:00"},
    ],
    "calls": [],
}


def _store() -> dict[str, Any]:
    return load_store("communications", _DEFAULT)


def _save(payload: dict[str, Any]) -> None:
    save_store("communications", payload)


def _find_contact(name: str) -> dict[str, Any] | None:
    lower = name.lower().strip()
    for item in _store()["contacts"]:
        if lower and lower in item["name"].lower():
            return item
    return None


def search_contacts(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("resolved_target") or payload.get("chunk_text") or "").lower()
    contacts = [item for item in _store()["contacts"] if query in item["name"].lower()]
    if not contacts:
        return AdapterResult(output_text="I couldn't find a matching contact.", success=False, error="missing contact").to_payload()
    preview = " | ".join(f"{item['name']} {item['phone']}" for item in contacts)
    return AdapterResult(output_text=f"Contacts: {preview}.", success=True, mechanism_used="local_contacts", data={"contacts": contacts}).to_payload()


def send_text_message(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    person = str(params.get("person_name") or payload.get("resolved_target") or "Unknown")
    body = str(params.get("body") or _extract_message_body(str(payload.get("chunk_text") or "")) or "")
    contact = _find_contact(person) or {"name": person, "phone": "unknown"}
    store = _store()
    message = {
        "id": next_id(store["messages"], "msg"),
        "to": contact["name"],
        "phone": contact.get("phone"),
        "body": body or "(empty)",
        "sent_at": datetime.now().isoformat(timespec="seconds"),
    }
    store["messages"].append(message)
    _save(store)
    return AdapterResult(output_text=f"Sent text to {contact['name']}: {message['body']}", success=True, mechanism_used="local_messages", data=message).to_payload()


def _extract_message_body(text: str) -> str:
    match = re.search(r"\bthat\s+(.+)$", text.strip(), re.IGNORECASE)
    return match.group(1).strip() if match else ""


def read_messages(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    person = str(params.get("person") or payload.get("resolved_target") or "").lower()
    count = int(params.get("count") or 3)
    messages = _store()["messages"]
    if person:
        messages = [item for item in messages if person in item["to"].lower()]
    messages = messages[-count:]
    if not messages:
        return AdapterResult(output_text="No matching messages found.", success=True).to_payload()
    preview = " | ".join(f"To {item['to']}: {item['body']}" for item in messages)
    return AdapterResult(output_text=f"Messages: {preview}.", success=True, data={"messages": messages}).to_payload()


def read_emails(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    folder = str(params.get("folder") or "inbox").lower()
    filter_text = str(params.get("filter") or payload.get("chunk_text") or "").lower()
    emails = [item for item in _store()["emails"] if folder in item["folder"].lower()]
    if "from" in filter_text:
        for contact in _store()["contacts"]:
            if contact["name"].lower() in filter_text:
                emails = [item for item in emails if contact["name"].lower() in item["from"].lower()]
                break
    if not emails:
        return AdapterResult(output_text="No matching emails found.", success=True).to_payload()
    preview = " | ".join(f"{item['from']}: {item['subject']}" for item in emails[:5])
    return AdapterResult(output_text=f"Emails: {preview}.", success=True, data={"emails": emails[:5]}).to_payload()


def make_call(payload: dict[str, Any]) -> dict[str, Any]:
    person = str((payload.get("params") or {}).get("person") or payload.get("resolved_target") or payload.get("chunk_text") or "")
    contact = _find_contact(person) or {"name": person, "phone": "unknown"}
    store = _store()
    call = {"id": next_id(store["calls"], "call"), "person": contact["name"], "phone": contact["phone"], "started_at": datetime.now().isoformat(timespec="seconds")}
    store["calls"].append(call)
    _save(store)
    return AdapterResult(output_text=f"Calling {contact['name']} at {contact['phone']}.", success=True, mechanism_used="local_calls", data=call).to_payload()
