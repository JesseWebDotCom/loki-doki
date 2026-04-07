"""Decomposer-output → MemoryProvider persistence helpers.

Extracted from ``orchestrator.py`` so that file stays under the
250-line CLAUDE.md ceiling. The orchestrator iterates the decomposer's
``long_term_memory`` and hands each item to ``persist_long_term_item``,
which resolves the subject (self vs. person), writes the fact, and
optionally writes a relationship edge.

Legacy shape tolerance
----------------------
Pre-PR3 items used ``{"category": ..., "fact": ...}``. We accept both
shapes so that a stale decomposer mock, a half-upgraded test fixture,
or an in-flight model rollout can't silently drop user data. Legacy
items become ``self`` facts with predicate ``states``.
"""
from __future__ import annotations

from lokidoki.core.memory_provider import MemoryProvider


async def persist_long_term_item(
    memory: MemoryProvider,
    *,
    user_id: int,
    user_msg_id: int,
    item: dict,
) -> None:
    """Write one structured fact (and optional relationship edge)."""
    if "fact" in item and "value" not in item:
        value = item.get("fact")
        if not value:
            return
        await memory.upsert_fact(
            user_id=user_id,
            subject="self",
            predicate="states",
            value=value,
            category=item.get("category", "general"),
            source_message_id=user_msg_id,
        )
        return

    value = item.get("value")
    if not value:
        return
    predicate = item.get("predicate") or "states"
    subject_type = item.get("subject_type", "self")
    subject_name = (item.get("subject_name") or "").strip()

    person_id: int | None = None
    if subject_type == "person" and subject_name:
        person_id = await memory.find_or_create_person(user_id, subject_name)
        fact_subject = subject_name.lower()
    else:
        subject_type = "self"
        fact_subject = "self"

    await memory.upsert_fact(
        user_id=user_id,
        subject=fact_subject,
        subject_type=subject_type,
        subject_ref_id=person_id,
        predicate=predicate,
        value=value,
        category=item.get("category", "general"),
        source_message_id=user_msg_id,
    )

    rel_kind = (item.get("relationship_kind") or "").strip()
    if item.get("kind") == "relationship" and person_id is not None and rel_kind:
        await memory.add_relationship(user_id, person_id, rel_kind)
