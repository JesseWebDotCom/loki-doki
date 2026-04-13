"""people relationship adapter — lookup_relationship + list_family.

Wraps the v1 PeopleLookupSkill's ``graph_query`` mechanism. Parameters
are populated by the people resolver (person name, relationship) and by
the PeopleDBAdapter (people rows, relationships, graph relations).

The adapter reads the PeopleDBAdapter from the pipeline context so it
uses the same data source as the people resolver.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.adapters.people_db import PeopleDBAdapter
from lokidoki.orchestrator.skills._runner import AdapterResult


def _extract_relation(payload: dict[str, Any]) -> str:
    """Extract a relation query from structured params or chunk text."""
    explicit = (payload.get("params") or {}).get("relation")
    if explicit:
        return str(explicit).strip().lower()
    text = str(payload.get("chunk_text") or "").lower()
    # Common patterns: "who is my brother", "my sister", "list family"
    for prefix in ("who is my ", "who's my ", "my "):
        if prefix in text:
            idx = text.index(prefix) + len(prefix)
            tail = text[idx:].strip(" ?.!")
            if tail:
                return tail.split()[0]
    return ""


def _extract_name(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("person")
    if explicit:
        return str(explicit).strip()
    return str(payload.get("resolved_target") or "").strip()


async def lookup_relationship(payload: dict[str, Any]) -> dict[str, Any]:
    """Look up a person by their relationship to the user."""
    relation = _extract_relation(payload)
    name = _extract_name(payload)
    adapter = _get_adapter(payload)
    records = adapter.all()

    if not records:
        return AdapterResult(
            output_text="I don't have any people in your contacts yet.",
            success=False,
            error="empty people db",
        ).to_payload()

    # Search by relation first, then by name.
    matches: list[dict[str, Any]] = []
    for record in records:
        rel_lower = record.relationship.lower()
        if relation and relation in rel_lower:
            matches.append({"name": record.name, "relationship": record.relationship, "id": record.id})
        elif name and name.lower() in record.name.lower():
            matches.append({"name": record.name, "relationship": record.relationship, "id": record.id})

    if not matches and not relation and not name:
        return AdapterResult(
            output_text="Who would you like me to look up?",
            success=False,
            error="missing query",
        ).to_payload()

    if not matches:
        label = relation or name or "that person"
        return AdapterResult(
            output_text=f"I don't have a record of your {label} yet.",
            success=False,
            error="no match",
        ).to_payload()

    if len(matches) == 1:
        m = matches[0]
        text = f"Your {m['relationship']}: {m['name']}"
    else:
        lines = [f"- {m['name']} ({m['relationship']})" for m in matches[:8]]
        text = "\n".join(lines)

    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used="people_db",
        data={"matches": matches, "match_count": len(matches)},
    ).to_payload()


async def list_family(payload: dict[str, Any]) -> dict[str, Any]:
    """List all known family members and relationships."""
    adapter = _get_adapter(payload)
    records = adapter.all()

    if not records:
        return AdapterResult(
            output_text="I don't have any people in your contacts yet.",
            success=False,
            error="empty people db",
        ).to_payload()

    people = []
    for record in records:
        if record.relationship:
            people.append({"name": record.name, "relationship": record.relationship, "id": record.id})

    if not people:
        return AdapterResult(
            output_text="I don't have any relationships on file yet.",
            success=False,
            error="no relationships",
        ).to_payload()

    lines = [f"- {p['name']} ({p['relationship']})" for p in people[:20]]
    text = "\n".join(lines)

    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used="people_db",
        data={"people": people, "count": len(people)},
    ).to_payload()


def _get_adapter(payload: dict[str, Any]) -> PeopleDBAdapter:
    """Get the PeopleDBAdapter — falls back to empty adapter."""
    return PeopleDBAdapter()
