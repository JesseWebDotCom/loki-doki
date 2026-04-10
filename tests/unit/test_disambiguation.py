"""Tests for orchestrator_memory disambiguation scoring."""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401  side-effect bind
from lokidoki.core.orchestrator_memory import (
    build_silent_confirmations,
    persist_long_term_item,
)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


@pytest.fixture
def memory(tmp_path):
    db_path = tmp_path / "test.db"
    mp = MemoryProvider(db_path=str(db_path))

    async def _setup():
        await mp.initialize()
        return await mp.get_or_create_user("tester")

    uid = _run(_setup())
    yield mp, uid
    _run(mp.close())


class TestSilentConfirmationDedup:
    def test_dedupes_by_fact_id(self):
        # Decomposer emitted two synonym items that hit the same row.
        reports = [
            {"fact_id": 7, "subject_label": "Artie", "predicate": "loves",
             "value": "movies", "status": "active", "person_id": 1,
             "ambiguity_group_id": None, "candidate_ids": [1],
             "contradiction": {"action": "none"}},
            {"fact_id": 7, "subject_label": "Artie", "predicate": "likes",
             "value": "movies", "status": "active", "person_id": 1,
             "ambiguity_group_id": None, "candidate_ids": [1],
             "contradiction": {"action": "none"}},
        ]
        confs = build_silent_confirmations(reports)
        assert len(confs) == 1
        assert confs[0]["fact_id"] == 7

    def test_keeps_distinct_facts(self):
        reports = [
            {"fact_id": 7, "subject_label": "Artie", "predicate": "loves",
             "value": "movies", "status": "active", "person_id": 1,
             "ambiguity_group_id": None, "candidate_ids": [1],
             "contradiction": {"action": "none"}},
            {"fact_id": 8, "subject_label": "Artie", "predicate": "is",
             "value": "brother", "status": "active", "person_id": 1,
             "ambiguity_group_id": None, "candidate_ids": [1],
             "contradiction": {"action": "none"}},
        ]
        confs = build_silent_confirmations(reports)
        assert len(confs) == 2


def test_unique_name_binds_directly(memory):
    mp, uid = memory
    item = {
        "subject_type": "person", "subject_name": "Tom",
        "predicate": "loves", "value": "Halo", "kind": "fact",
        "category": "preference",
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item, user_input="Tom loves Halo",
    ))
    assert report["status"] == "active"
    assert report["person_id"] is not None
    assert report["ambiguity_group_id"] is None


def test_two_artie_no_hint_is_ambiguous(memory):
    mp, uid = memory
    a1 = _run(mp.create_person(uid, "Artie"))
    a2 = _run(mp.create_person(uid, "Artie"))
    item = {
        "subject_type": "person", "subject_name": "Artie",
        "predicate": "loves", "value": "movies", "kind": "fact",
        "category": "preference",
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item, user_input="Artie loves movies",
    ))
    assert report["status"] == "ambiguous"
    assert report["ambiguity_group_id"] is not None
    assert set(report["candidate_ids"]) == {a1, a2}


def test_relationship_hint_resolves(memory):
    mp, uid = memory
    a_brother = _run(mp.create_person(uid, "Artie"))
    a_dog = _run(mp.create_person(uid, "Artie"))
    _run(mp.add_relationship(uid, a_brother, "brother"))

    item = {
        "subject_type": "person", "subject_name": "Artie",
        "predicate": "loves", "value": "movies", "kind": "fact",
        "category": "preference",
        # Decomposer is now responsible for emitting the relation hint
        # on every person item, not just the dedicated relationship row.
        "relationship_kind": "brother",
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item,
        user_input="My brother Artie loves movies",
    ))
    assert report["status"] == "active"
    assert report["person_id"] == a_brother


def test_set_primary_relationship_replaces_existing(memory):
    """Picking a different relation in the UI must REPLACE the existing
    one, not stack a second row. The dropdown is a single-value picker."""
    mp, uid = memory
    pid = _run(mp.create_person(uid, "Artie"))
    _run(mp.add_relationship(uid, pid, "brother"))
    rels = _run(mp.list_relationships(uid))
    assert len([r for r in rels if r["person_id"] == pid]) == 1
    assert rels[0]["relation"] == "brother"

    # User changes the dropdown from brother → cousin.
    new_id = _run(mp.set_primary_relationship(uid, pid, "cousin"))
    assert new_id > 0
    rels = _run(mp.list_relationships(uid))
    person_rels = [r for r in rels if r["person_id"] == pid]
    assert len(person_rels) == 1, "must replace, not stack"
    assert person_rels[0]["relation"] == "cousin"


def test_set_primary_relationship_empty_clears(memory):
    """Empty string clears all relationships for the person."""
    mp, uid = memory
    pid = _run(mp.create_person(uid, "Tom"))
    _run(mp.add_relationship(uid, pid, "coworker"))
    _run(mp.set_primary_relationship(uid, pid, ""))
    rels = _run(mp.list_relationships(uid))
    assert not any(r["person_id"] == pid for r in rels)


def test_brother_relationship_auto_created_from_relationship_kind(memory):
    """When the decomposer emits a person preference item that carries
    relationship_kind (because the user said "my brother artie loves
    movies"), the orchestrator must auto-create the brother edge even
    though this item's kind is 'fact', not 'relationship'.
    """
    mp, uid = memory
    item = {
        "subject_type": "person", "subject_name": "Artie",
        "predicate": "loves", "value": "movies", "kind": "fact",
        "category": "preference",
        "relationship_kind": "brother",
    }
    _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item,
        user_input="my brother artie loves movies",
    ))
    rels = _run(mp.list_relationships(uid))
    assert any(r["relation"] == "brother" for r in rels), \
        f"brother relationship not auto-created; got {rels}"


def test_explicit_relation_in_user_input_overrides_bad_llm_relation(memory):
    mp, uid = memory
    item = {
        "subject_type": "person", "subject_name": "Sandi",
        "predicate": "is", "value": "sister-in-law", "kind": "relationship",
        "category": "relationship",
        "relationship_kind": "sister-in-law",
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item,
        user_input="my sister Sandi would find this funny",
    ))
    assert report["value"] == "sister"
    rels = _run(mp.list_relationships(uid))
    assert any(r["relation"] == "sister" for r in rels), rels
    facts = _run(mp.list_facts(uid))
    assert any(
        f["subject"] == "sandi" and f["predicate"] == "is" and f["value"] == "sister"
        for f in facts
    )


def test_resolve_ambiguity_group_binds_facts(memory):
    mp, uid = memory
    a1 = _run(mp.create_person(uid, "Artie"))
    a2 = _run(mp.create_person(uid, "Artie"))
    item = {
        "subject_type": "person", "subject_name": "Artie",
        "predicate": "loves", "value": "movies", "kind": "fact",
        "category": "preference",
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item, user_input="Artie loves movies",
    ))
    group_id = report["ambiguity_group_id"]
    assert group_id is not None
    ok = _run(mp.resolve_ambiguity_group(uid, group_id, a1))
    assert ok
    facts = _run(mp.list_facts_about_person(uid, a1))
    assert any(f["value"] == "movies" for f in facts)
