"""Tests for orchestrator_memory disambiguation scoring."""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401  side-effect bind
from lokidoki.core.orchestrator_memory import (
    _extract_relationship_hint,
    _extract_relationship_from_input,
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


class TestRelationshipFromInput:
    def test_brother_pair(self):
        assert _extract_relationship_from_input("my brother artie loves movies", "Artie") == "brother"

    def test_dog_pair_case_insensitive(self):
        assert _extract_relationship_from_input("My Dog Artie hates baths", "artie") == "dog"

    def test_no_match_when_name_absent(self):
        assert _extract_relationship_from_input("my brother bob", "Artie") is None

    def test_unknown_relation_rejected(self):
        # "my favorite restaurant Olive serves breadsticks" — Olive is not a person
        assert _extract_relationship_from_input("my favorite restaurant Olive", "Olive") is None


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


class TestRelationshipHint:
    def test_brother(self):
        assert _extract_relationship_hint("My brother Artie loves movies", "Artie") == "brother"

    def test_dog(self):
        assert _extract_relationship_hint("My dog Artie hates baths", "Artie") == "dog"

    def test_no_hint(self):
        assert _extract_relationship_hint("Artie loves movies", "Artie") is None


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
    }
    report = _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item,
        user_input="My brother Artie loves movies",
    ))
    assert report["status"] == "active"
    assert report["person_id"] == a_brother


def test_brother_relationship_auto_created_from_input(memory):
    """When the user says "my brother artie loves movies" and the
    decomposer only emits the loves-movies fact (no separate
    relationship item), the orchestrator must still auto-create the
    brother edge from the "my <relation> <name>" pattern in the input.
    """
    mp, uid = memory
    item = {
        "subject_type": "person", "subject_name": "Artie",
        "predicate": "loves", "value": "movies", "kind": "fact",
        "category": "preference",
    }
    _run(persist_long_term_item(
        mp, user_id=uid, user_msg_id=None, item=item,
        user_input="my brother artie loves movies",
    ))
    rels = _run(mp.list_relationships(uid))
    assert any(r["relation"] == "brother" for r in rels), \
        f"brother relationship not auto-created; got {rels}"


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
