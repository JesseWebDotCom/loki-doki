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

logger = logging.getLogger(__name__)


# Tunables for the disambiguation scoring. Margin threshold is the
# minimum score gap between top and runner-up candidates required to
# auto-bind without flagging as ambiguous.
DISAMBIG_MARGIN = 1.0


async def _score_candidate(
    memory: MemoryProvider,
    user_id: int,
    person: dict,
    user_input: str,
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

    # Relationship match: if the user said "my brother Artie" and this
    # candidate has a 'brother' relationship row, that's a strong signal.
    if relationship_hint:
        rels = await memory.list_relationships(user_id)
        for r in rels:
            if r["person_id"] == person["id"] and r["relation"].lower() == relationship_hint.lower():
                score += 3.0
                break

    # Recency tiebreaker: more recently created people slightly preferred.
    score += float(person["id"]) * 0.001
    return score


_RELATION_WORDS = {
    "brother", "sister", "mother", "father", "mom", "dad", "son", "daughter",
    "wife", "husband", "spouse", "friend", "coworker", "boss", "uncle", "aunt",
    "cousin", "nephew", "niece", "grandma", "grandpa", "neighbor", "dog", "cat",
    "pet",
}


def _extract_relationship_hint(user_input: str, name: str) -> Optional[str]:
    """Find a relation word that precedes the name in the user message.

    "my brother Artie" -> 'brother'. "Artie" alone -> None.
    """
    if not user_input or not name:
        return None
    low = user_input.lower()
    name_low = name.lower()
    idx = low.find(name_low)
    if idx <= 0:
        return None
    prefix = low[:idx].strip().split()
    for word in reversed(prefix[-4:]):
        cleaned = word.strip(",.;:!?")
        if cleaned in _RELATION_WORDS:
            return cleaned
    return None


def _extract_relationship_from_input(user_input: str, name: str) -> Optional[str]:
    """Like ``_extract_relationship_hint`` but matches 'my <relation> <name>'.

    Used as a salvage after binding a person fact: if the input clearly
    carries "my brother artie", return 'brother' so the orchestrator can
    auto-create the relationship edge. Case-insensitive on both sides.
    """
    if not user_input or not name:
        return None
    import re as _re

    pattern = _re.compile(
        rf"\bmy\s+(\w+)\s+{_re.escape(name)}\b",
        _re.IGNORECASE,
    )
    m = pattern.search(user_input)
    if not m:
        return None
    relation = m.group(1).lower()
    return relation if relation in _RELATION_WORDS else None


async def _resolve_person(
    memory: MemoryProvider,
    *,
    user_id: int,
    name: str,
    user_input: str,
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
    relationship_hint = _extract_relationship_hint(user_input, name)
    scored: list[tuple[float, dict]] = []
    for c in candidates:
        s = await _score_candidate(
            memory, user_id, c, user_input, relationship_hint, recent_msg_window_start
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

    person_id: Optional[int] = None
    ambiguity_group_id: Optional[int] = None
    candidate_ids: list[int] = []
    fact_status = "active"

    if subject_type == "person" and subject_name:
        person_id, ambiguity_group_id, candidate_ids = await _resolve_person(
            memory,
            user_id=user_id,
            name=subject_name,
            user_input=user_input,
            recent_msg_window_start=recent_msg_window_start,
        )
        fact_subject = subject_name.lower()
        if ambiguity_group_id is not None:
            fact_status = "ambiguous"
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
    )

    rel_kind = (item.get("relationship_kind") or "").strip()
    if (
        item.get("kind") == "relationship"
        and person_id is not None
        and rel_kind
    ):
        await memory.add_relationship(user_id, person_id, rel_kind)

    # Inferred-relationship salvage. The decomposer is small and rarely
    # emits a separate relationship item, even when the user clearly says
    # "my brother artie loves movies". If we just bound a fact to a
    # person AND the user input contains a "my <relation> <Name>" pair
    # whose Name matches the bound person, auto-create the relationship
    # so the brother edge actually shows up in the People tab.
    if person_id is not None and subject_name:
        pair = _extract_relationship_from_input(user_input, subject_name)
        if pair:
            try:
                await memory.add_relationship(user_id, person_id, pair)
            except Exception:
                logger.exception("[orchestrator_memory] add_relationship failed")

    return {
        "fact_id": fact_id,
        "subject_label": subject_name if subject_type == "person" else "you",
        "predicate": predicate,
        "value": value,
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
