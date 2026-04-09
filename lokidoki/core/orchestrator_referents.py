"""Typed referent-context assembly for synthesis.

This module formats recent turns and memory search hits into explicit
typed blocks so synthesis can resolve short follow-ups without relying
on brittle phrase heuristics in Python routing code.
"""
from __future__ import annotations

from typing import Iterable


def _recent_referents(recent: Iterable[dict], *, limit: int = 3) -> list[str]:
    lines: list[str] = []
    for msg in list(recent)[-limit:]:
        role = (msg.get("role") or "").strip()
        content = (msg.get("content") or "").strip()
        if not (role and content):
            continue
        lines.append(f"- {role}: {content}")
    return lines


def _resolved_referents(candidates: Iterable[object], *, limit: int = 4) -> list[str]:
    lines: list[str] = []
    for cand in list(candidates)[:limit]:
        canonical = (getattr(cand, "canonical_name", "") or "").strip()
        ctype = (getattr(cand, "type", "") or "").strip()
        source = (getattr(cand, "source", "") or "").strip()
        if canonical:
            prefix = f"{ctype}: " if ctype else ""
            suffix = f" ({source})" if source else ""
            lines.append(f"- {prefix}{canonical}{suffix}")
    return lines


def _memory_people(people: Iterable[dict], relationships: Iterable[dict], *, limit: int = 4) -> list[str]:
    names = {int(p["id"]): (p.get("name") or "").strip() for p in people if p.get("id") is not None}
    lines: list[str] = []
    for rel in list(relationships)[:limit]:
        pid = int(rel.get("person_id") or 0)
        name = names.get(pid, "").strip()
        relation = (rel.get("relation") or "").strip()
        if name and relation:
            lines.append(f"- {relation}: {name}")
    return lines


def _memory_entities(facts: Iterable[dict], *, limit: int = 4) -> list[str]:
    lines: list[str] = []
    for fact in list(facts)[:limit]:
        if (fact.get("subject_type") or "") != "entity":
            continue
        subject = (fact.get("subject") or "").strip()
        predicate = (fact.get("predicate") or "").strip()
        value = (fact.get("value") or "").strip()
        if subject and predicate and value:
            lines.append(f"- {subject} {predicate} {value}")
    return lines


def _older_turns(past_messages: Iterable[dict], *, limit: int = 3) -> list[str]:
    lines: list[str] = []
    for msg in list(past_messages)[:limit]:
        content = (msg.get("content") or "").strip()
        if content:
            lines.append(f"- {content}")
    return lines


def build_referent_block(
    *,
    recent: Iterable[dict],
    relevant_facts: Iterable[dict],
    past_messages: Iterable[dict],
    people: Iterable[dict],
    relationships: Iterable[dict],
    graph_relations: Iterable[str] = (),
    resolved_referents: Iterable[object] = (),
) -> str:
    sections: list[str] = []

    resolved_lines = _resolved_referents(resolved_referents)
    if resolved_lines:
        sections.append("RESOLVED_REFERENTS:")
        sections.extend(resolved_lines)

    recent_lines = _recent_referents(recent)
    if recent_lines:
        sections.append("RECENT_REFERENTS:")
        sections.extend(recent_lines)

    people_lines = _memory_people(people, relationships)
    if people_lines:
        sections.append("MEMORY_PEOPLE:")
        sections.extend(people_lines)

    graph_lines = [line for line in graph_relations if line]
    if graph_lines:
        sections.append("GRAPH_RELATIONSHIPS:")
        sections.extend(graph_lines)

    entity_lines = _memory_entities(relevant_facts)
    if entity_lines:
        sections.append("MEMORY_ENTITIES:")
        sections.extend(entity_lines)

    older_lines = _older_turns(past_messages)
    if older_lines:
        sections.append("OLDER_RELATED_TURNS:")
        sections.extend(older_lines)

    return "\n".join(sections)
