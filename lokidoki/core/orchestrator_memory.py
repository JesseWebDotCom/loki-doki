"""Decomposer-output → MemoryProvider persistence + disambiguation.

Resolves ``subject_type='person'`` items to a concrete people row using
relationship hints, recent co-occurrence, and recency. When the choice
is uncertain (multiple candidates and no decisive signal), the fact is
written with ``status='ambiguous'`` and tied to a new ambiguity_group
so the UI can prompt the user to pick the right person.

Returns a list of ``WriteReport`` dicts so the orchestrator can:
  - emit ``silent_confirmation`` SSE events for each successful write
  - inject a CLARIFY hint into the synthesis prompt when a fact landed
    ambiguous or a contradiction was uncertainly resolved
"""
from __future__ import annotations

import logging
from typing import Optional

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import people_graph_sql as gql
from lokidoki.core.graph_walk_resolution import normalize_query
from lokidoki.core.known_subjects_resolver import extract_explicit_person_relations

logger = logging.getLogger(__name__)


# Tunables for the disambiguation scoring. Margin threshold is the
# minimum score gap between top and runner-up candidates required to
# auto-bind without flagging as ambiguous.
DISAMBIG_MARGIN = 1.0


async def _score_candidate(
    memory: MemoryProvider,
    user_id: int,
    person: dict,
    relationship_hint: Optional[str],
    recent_msg_window_start: int,
) -> float:
    score = 0.0
    # Recent co-occurrence in this session: each prior fact about this
    # person within the recent message window adds weight.
    refs = await memory.count_recent_session_refs(
        user_id, int(person["id"]), recent_msg_window_start
    )
    score += float(refs) * 0.5

    # Relationship match: the decomposer emits relationship_kind on every
    # person item when the user named the relation in the same sentence
    # ('my brother Luke' -> relationship_kind='brother'). If a candidate
    # already has that relation on file, that's a strong bind signal.
    if relationship_hint:
        rels = await memory.list_relationships(user_id)
        hint_low = relationship_hint.lower()
        # Also check the mapped edge_type (e.g. "mother" → "parent").
        from lokidoki.core.people_graph_sql import relation_to_edge_type
        mapped_edge, _ = relation_to_edge_type(relationship_hint)
        for r in rels:
            rel_low = (r.get("relation") or "").lower()
            if r["person_id"] == person["id"] and (
                rel_low == hint_low or rel_low == mapped_edge
            ):
                score += 3.0
                break

    # Recency tiebreaker: more recently created people slightly preferred.
    score += float(person["id"]) * 0.001
    return score


async def _resolve_person(
    memory: MemoryProvider,
    *,
    user_id: int,
    name: str,
    relationship_hint: Optional[str],
    recent_msg_window_start: int,
) -> tuple[Optional[int], Optional[int], list[int]]:
    """Pick the right person row, or flag as ambiguous.

    Returns ``(person_id, ambiguity_group_id, candidate_ids)``.
    - ``person_id`` is set when we have a confident bind.
    - ``ambiguity_group_id`` is set when multiple candidates were viable
      and no clear winner emerged; the fact should be written ambiguous.
    - ``candidate_ids`` is the full set considered (for the group).
    """
    candidates = await memory.find_people_by_name(user_id, name)
    if not candidates:
        # Brand new person — create and bind.
        new_id = await memory.create_person(user_id, name)
        return new_id, None, [new_id]

    if len(candidates) == 1:
        return int(candidates[0]["id"]), None, [int(candidates[0]["id"])]

    # Multiple candidates — score them.
    scored: list[tuple[float, dict]] = []
    for c in candidates:
        s = await _score_candidate(
            memory, user_id, c, relationship_hint, recent_msg_window_start
        )
        scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    top_score, top = scored[0]
    runner_score = scored[1][0] if len(scored) > 1 else 0.0

    if top_score - runner_score >= DISAMBIG_MARGIN:
        return int(top["id"]), None, [int(c["id"]) for c in candidates]

    # Ambiguous — create a group, return None for person_id.
    candidate_ids = [int(c["id"]) for c in candidates]
    group_id = await memory.create_ambiguity_group(user_id, name, candidate_ids)
    return None, group_id, candidate_ids


async def persist_long_term_item(
    memory: MemoryProvider,
    *,
    user_id: int,
    user_msg_id: int,
    item: dict,
    user_input: str = "",
    recent_msg_window_start: int = 0,
) -> dict:
    """Write one structured fact and return a report dict.

    Report shape:
        {
          "fact_id": int | None,
          "subject_label": str,
          "predicate": str,
          "value": str,
          "status": "active" | "ambiguous",
          "ambiguity_group_id": int | None,
          "candidate_ids": list[int],
          "contradiction": dict (from upsert_fact),
          "person_id": int | None,
        }
    """
    # Legacy shape passthrough.
    if "fact" in item and "value" not in item:
        value = item.get("fact")
        if not value:
            return {}
        fact_id, conf, contradiction = await memory.upsert_fact(
            user_id=user_id,
            subject="self",
            predicate="states",
            value=value,
            category=item.get("category", "general"),
            source_message_id=user_msg_id,
        )
        return {
            "fact_id": fact_id, "subject_label": "you",
            "predicate": "states", "value": value,
            "status": "active", "ambiguity_group_id": None,
            "candidate_ids": [], "contradiction": contradiction,
            "person_id": None,
        }

    value = item.get("value")
    if not value:
        return {}
    predicate = item.get("predicate") or "states"
    subject_type = item.get("subject_type", "self")
    subject_name = (item.get("subject_name") or "").strip()
    negates_previous = bool(item.get("negates_previous", False))
    kind = item.get("kind") or "fact"
    memory_priority = (item.get("memory_priority") or "normal").strip().lower()

    # "low" is a soft "don't pollute the durable profile" signal —
    # historically used to drop speculative self memory writes on
    # ephemeral lookup turns. Entity rows ("Avatar is a movie") are
    # facts about the world, not speculation about the user, AND they
    # are load-bearing for cross-turn referent resolution: dropping
    # them silently means turn N+1 cannot resolve "is it still playing"
    # against the entity from turn N. Only drop low-priority *self*
    # writes — entities and people always persist.
    if memory_priority == "low" and subject_type == "self":
        return {}

    # The garbage-name guard lives in decomposer_repair.coerce_item — that
    # is the single chokepoint every decomposer item passes through. We
    # used to mirror it here as defense-in-depth, but the duplicate was a
    # keyword list (`who/what/where/...`) that drifted out of sync. The
    # structured decomposer output is now the source of truth.

    # Structured relationship hint from the decomposer. The 2B model is
    # responsible for extracting "my <relation> Name" into a typed field
    # — orchestrator code does NOT regex the user input.
    relationship_hint = (item.get("relationship_kind") or "").strip() or None
    explicit_pairs = extract_explicit_person_relations(user_input or "")
    if subject_type == "person" and subject_name:
        name_norm = normalize_query(subject_name)
        for explicit_name, explicit_relation in explicit_pairs:
            if normalize_query(explicit_name) != name_norm:
                continue
            relationship_hint = explicit_relation
            if predicate == "is" and kind in ("relationship", "fact"):
                value = explicit_relation
            break
    person_bucket = (item.get("person_bucket") or "").strip() or None
    relationship_state = (item.get("relationship_state") or "").strip() or None
    interaction_preference = (item.get("interaction_preference") or "").strip() or None
    event_type = (item.get("event_type") or "").strip() or None
    event_date_precision = (item.get("event_date_precision") or "").strip() or "exact"

    person_id: Optional[int] = None
    ambiguity_group_id: Optional[int] = None
    candidate_ids: list[int] = []
    fact_status = "active"

    if subject_type == "person" and subject_name:
        person_id, ambiguity_group_id, candidate_ids = await _resolve_person(
            memory,
            user_id=user_id,
            name=subject_name,
            relationship_hint=relationship_hint,
            recent_msg_window_start=recent_msg_window_start,
        )
        fact_subject = subject_name.lower()
        if ambiguity_group_id is not None:
            fact_status = "ambiguous"
    elif subject_type == "entity" and subject_name:
        # Entities are named non-person things (movies, books, places).
        # No people row, no disambiguation — just stamp the lowercased
        # name as the subject. Dedup happens on (subject, predicate, value)
        # exactly the same way as person/self.
        fact_subject = subject_name.lower()
    else:
        subject_type = "self"
        fact_subject = "self"

    fact_id, conf, contradiction = await memory.upsert_fact(
        user_id=user_id,
        subject=fact_subject,
        subject_type=subject_type,
        subject_ref_id=person_id,
        predicate=predicate,
        value=value,
        category=item.get("category", "general"),
        source_message_id=user_msg_id,
        status=fact_status,
        ambiguity_group_id=ambiguity_group_id,
        negates_previous=negates_previous,
        kind=kind,
    )

    # Auto-create the relationship edge whenever the decomposer told us
    # the relation, regardless of whether this item is the dedicated
    # relationship row or just a preference/event item that carried
    # relationship_kind along as a disambiguation hint. add_relationship
    # is idempotent, so emitting the brother edge twice (once from the
    # preference item, once from the relationship item gemma also emits)
    # is harmless.
    if person_id is not None and relationship_hint:
        try:
            await memory.add_relationship(user_id, person_id, relationship_hint)
        except Exception:
            logger.exception("[orchestrator_memory] add_relationship failed")
    if person_id is not None:
        try:
            if person_bucket:
                await memory.run_sync(
                    lambda conn: gql.patch_person_graph(conn, person_id, bucket=person_bucket)
                )
            if relationship_state or interaction_preference:
                await memory.run_sync(
                    lambda conn: gql.set_person_overlay(
                        conn,
                        user_id,
                        person_id,
                        relationship_state=relationship_state,
                        interaction_preference=interaction_preference,
                    )
                )
            if kind == "event" and event_type:
                await memory.run_sync(
                    lambda conn: gql.create_person_event(
                        conn,
                        person_id=person_id,
                        event_type=event_type,
                        event_date=value,
                        date_precision=event_date_precision,
                        label=predicate,
                        value=value,
                        source="conversation",
                    )
                )
        except Exception:
            logger.exception("[orchestrator_memory] people graph enrichment failed")

    if subject_type == "person":
        subject_label = subject_name
    elif subject_type == "entity":
        subject_label = subject_name
    else:
        subject_label = "you"

    return {
        "fact_id": fact_id,
        "subject_label": subject_label,
        "subject_type": subject_type,
        "predicate": predicate,
        "value": value,
        "kind": kind,
        "memory_priority": memory_priority,
        "status": fact_status,
        "ambiguity_group_id": ambiguity_group_id,
        "candidate_ids": candidate_ids,
        "contradiction": contradiction,
        "person_id": person_id,
    }


def build_clarification_hint(reports: list[dict]) -> Optional[str]:
    """Pick at most one clarification question to inject into synthesis.

    Returns a short instruction string, or None if no clarification is
    warranted. The synthesis prompt already accommodates a friendly
    follow-up question; this just gives it a concrete one.
    """
    for r in reports:
        if not r:
            continue
        if r.get("status") == "ambiguous":
            name = r.get("subject_label") or "that person"
            return (
                f"You just heard a fact about '{name}', but you know multiple "
                f"people by that name. Ask the user once, in one short sentence, "
                f"which {name} they mean (mention you'll remember it)."
            )
    for r in reports:
        if not r:
            continue
        contradiction = r.get("contradiction") or {}
        if contradiction.get("action") == "revise" and contradiction.get("margin", 0) < 0.2:
            old = contradiction.get("loser_value")
            new = r.get("value")
            return (
                f"The user just said '{new}' but you previously had '{old}' "
                f"on file for the same fact. Ask one short, friendly clarifying "
                f"question to confirm which is correct."
            )
    return None


def build_silent_confirmations(reports: list[dict]) -> list[dict]:
    """Per-fact silent confirmation chips for the chat UI.

    Deduplicated by ``fact_id``: when the decomposer emits two items
    that hit the same row (e.g. ``{loves, movies}`` and ``{likes, movies}``
    after gemma's synonym wobble), we only show one chip.
    """
    out: list[dict] = []
    seen: set[int] = set()
    for r in reports:
        if not r or not r.get("fact_id"):
            continue
        fid = int(r["fact_id"])
        if fid in seen:
            continue
        seen.add(fid)
        contradiction = r.get("contradiction") or {}
        action = contradiction.get("action", "none")
        out.append({
            "fact_id": fid,
            "subject": r.get("subject_label", "you"),
            "predicate": r.get("predicate", ""),
            "value": r.get("value", ""),
            "status": r.get("status", "active"),
            "person_id": r.get("person_id"),
            "ambiguity_group_id": r.get("ambiguity_group_id"),
            "contradiction_action": action,
            "previous_value": contradiction.get("loser_value"),
        })
    return out
