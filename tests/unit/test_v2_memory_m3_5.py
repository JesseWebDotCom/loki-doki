"""
M3.5 phase-gate tests for the v2 memory subsystem.

M3.5 adds **auto-merge by relation** to the social write path. When a
named ``person:X`` arrives via ``is_relation`` and a single provisional
handle row already has the same relation label, the writer promotes the
provisional row in place instead of creating a duplicate.

This closes the cross-turn UX gap from M3:
    Turn 1: "my boss is being weird" → provisional row (name=NULL, handle="my boss")
    Turn 2: "my boss Steve approved it" → BEFORE M3.5 created a second row;
                                          AFTER M3.5 the existing row is promoted
                                          in place to (name="Steve", handle="my boss",
                                          provisional=0).

Each test corresponds to a deliverable from M3.5:

    1. Auto-merge promotes single matching provisional in place
    2. Auto-merge preserves the existing handle as a searchable alias
    3. Auto-merge preserves the existing relationship edges
    4. Auto-merge skips when zero matches (creates a fresh named row)
    5. Auto-merge skips when multiple provisional rows match the relation
       (ambiguous; defer to user)
    6. Auto-merge skips when the relation doesn't match
    7. Auto-merge skips when a named row with the same name already exists
    8. Cross-user isolation: auto-merge never crosses owner_user_id
    9. End-to-end through the v2 pipeline
"""
from __future__ import annotations

from pathlib import Path

import pytest

from v2.orchestrator.memory.candidate import MemoryCandidate
from v2.orchestrator.memory.reader import resolve_person
from v2.orchestrator.memory.store import V2MemoryStore


@pytest.fixture()
def store(tmp_path: Path) -> V2MemoryStore:
    s = V2MemoryStore(tmp_path / "v2_memory_m35.sqlite")
    yield s
    s.close()


def _seed_handle(store: V2MemoryStore, owner: int, handle: str, relation: str) -> None:
    store.write_social_fact(
        MemoryCandidate(
            subject=f"handle:{handle}",
            predicate="is_relation",
            value=relation,
            owner_user_id=owner,
            source_text=f"my {relation}",
        )
    )


def _name_relation(store: V2MemoryStore, owner: int, name: str, relation: str) -> None:
    store.write_social_fact(
        MemoryCandidate(
            subject=f"person:{name}",
            predicate="is_relation",
            value=relation,
            owner_user_id=owner,
            source_text=f"{name} is my {relation}",
        )
    )


# ----- Deliverable 1+2+3: auto-merge promotes in place ----------------


def test_m35_auto_merge_promotes_provisional_in_place(store: V2MemoryStore) -> None:
    _seed_handle(store, 1, "my boss", "boss")
    people_before = store.get_people(1)
    assert len(people_before) == 1
    assert people_before[0]["name"] is None
    assert people_before[0]["provisional"] == 1
    provisional_id = people_before[0]["id"]

    _name_relation(store, 1, "Steve", "boss")

    people_after = store.get_people(1)
    assert len(people_after) == 1, f"expected 1 row, got {people_after}"
    assert people_after[0]["id"] == provisional_id
    assert people_after[0]["name"] == "Steve"
    assert people_after[0]["handle"] == "my boss"
    assert people_after[0]["provisional"] == 0


def test_m35_auto_merge_preserves_relationship_edges(store: V2MemoryStore) -> None:
    _seed_handle(store, 1, "my therapist", "therapist")
    rels_before = store.get_relationships(1)
    assert len(rels_before) == 1
    assert rels_before[0]["relation_label"] == "therapist"

    _name_relation(store, 1, "Padme", "therapist")

    rels_after = store.get_relationships(1)
    # The existing edge stays; the new write was an UPSERT against the
    # same person_id so the unique index drops the duplicate.
    assert len(rels_after) == 1
    assert rels_after[0]["relation_label"] == "therapist"


def test_m35_auto_merge_resolvable_by_old_handle_and_new_name(store: V2MemoryStore) -> None:
    _seed_handle(store, 1, "my boss", "boss")
    _name_relation(store, 1, "Steve", "boss")
    by_name = resolve_person(store, 1, "Steve")
    by_handle = resolve_person(store, 1, "my boss")
    assert by_name.matched is not None
    assert by_handle.matched is not None
    assert by_name.matched.person_id == by_handle.matched.person_id
    assert by_name.matched.provisional is False


# ----- Deliverable 4: zero matches falls through ----------------------


def test_m35_no_merge_when_no_provisional_exists(store: V2MemoryStore) -> None:
    _name_relation(store, 1, "Luke", "brother")
    people = store.get_people(1)
    assert len(people) == 1
    assert people[0]["name"] == "Luke"
    assert people[0]["handle"] is None  # no handle to inherit
    assert people[0]["provisional"] == 0


# ----- Deliverable 5: multiple matches → defer ------------------------


def test_m35_no_merge_when_multiple_provisional_match_same_relation(store: V2MemoryStore) -> None:
    """If two provisional rows both have ``is_relation=boss``, the writer
    cannot pick one safely — both stay provisional and a fresh named
    row is created."""
    _seed_handle(store, 1, "my old boss", "boss")
    _seed_handle(store, 1, "my new boss", "boss")
    assert len(store.get_people(1)) == 2

    _name_relation(store, 1, "Steve", "boss")

    people = store.get_people(1)
    # Three rows: the two provisional handles + one new named Steve.
    assert len(people) == 3
    names = sorted(p["name"] or p["handle"] for p in people)
    assert "Steve" in names
    assert "my old boss" in names
    assert "my new boss" in names


# ----- Deliverable 6: relation must match -----------------------------


def test_m35_no_merge_when_relation_does_not_match(store: V2MemoryStore) -> None:
    _seed_handle(store, 1, "my therapist", "therapist")
    _name_relation(store, 1, "Padme", "friend")  # different relation
    people = store.get_people(1)
    assert len(people) == 2
    names = sorted((p["name"] or p["handle"]) for p in people)
    assert names == ["Padme", "my therapist"]
    # Each row has its own relation.
    therapist_row = next(p for p in people if p["handle"] == "my therapist")
    padme_row = next(p for p in people if p["name"] == "Padme")
    therapist_rels = store.get_relationships(1, person_id=therapist_row["id"])
    padme_rels = store.get_relationships(1, person_id=padme_row["id"])
    assert {r["relation_label"] for r in therapist_rels} == {"therapist"}
    assert {r["relation_label"] for r in padme_rels} == {"friend"}


# ----- Deliverable 7: name collision skips merge ---------------------


def test_m35_no_merge_when_named_row_with_same_name_already_exists(
    store: V2MemoryStore,
) -> None:
    """A pre-existing named ``Steve`` should NOT be touched by the
    auto-merge — the second write returns the existing named id and
    leaves the provisional row alone."""
    _name_relation(store, 1, "Steve", "friend")  # named Steve already exists
    _seed_handle(store, 1, "my boss", "boss")  # provisional my boss
    # Now an is_relation write for Steve with relation 'boss' — this
    # should hit the existing named row, NOT auto-merge into the
    # provisional row, because the named row already exists.
    store.write_social_fact(
        MemoryCandidate(
            subject="person:Steve",
            predicate="is_relation",
            value="boss",
            owner_user_id=1,
            source_text="Steve is my boss",
        )
    )
    people = store.get_people(1)
    # Two rows: the existing named Steve and the still-provisional handle.
    assert len(people) == 2
    steve = next(p for p in people if p["name"] == "Steve")
    boss_handle = next(p for p in people if p["handle"] == "my boss")
    assert boss_handle["provisional"] == 1
    assert boss_handle["name"] is None
    # Steve now has both 'friend' and 'boss' as relations.
    steve_rels = {r["relation_label"] for r in store.get_relationships(1, person_id=steve["id"])}
    assert steve_rels == {"friend", "boss"}


# ----- Deliverable 8: cross-user isolation ---------------------------


def test_m35_auto_merge_does_not_cross_owner_boundary(store: V2MemoryStore) -> None:
    _seed_handle(store, 1, "my boss", "boss")
    # User 2 names a Steve with relation boss — this must NOT touch
    # user 1's provisional row.
    _name_relation(store, 2, "Steve", "boss")
    user_1_people = store.get_people(1)
    user_2_people = store.get_people(2)
    assert len(user_1_people) == 1
    assert user_1_people[0]["provisional"] == 1
    assert user_1_people[0]["name"] is None
    assert len(user_2_people) == 1
    assert user_2_people[0]["name"] == "Steve"
    assert user_2_people[0]["handle"] is None  # nothing to inherit


# ----- Deliverable 9: end-to-end through the pipeline ---------------


def test_m35_end_to_end_provisional_then_named(tmp_path: Path) -> None:
    """Two-turn end-to-end: turn 1 says 'my boss is being weird', turn
    2 says 'my boss Steve approved it'. The dev store should end with
    exactly one row, named Steve, with the handle preserved."""
    from v2.orchestrator.core.pipeline import run_pipeline

    test_store = V2MemoryStore(tmp_path / "m35_e2e.sqlite")
    try:
        run_pipeline(
            "my boss is being weird",
            context={
                "memory_writes_enabled": True,
                "memory_store": test_store,
                "owner_user_id": 1,
            },
        )
        people = test_store.get_people(1)
        assert len(people) == 1
        assert people[0]["provisional"] == 1

        # The extractor produces "person:Steve is_relation boss" for
        # this utterance because Steve is the apposition of boss.
        run_pipeline(
            "my boss Steve approved it",
            context={
                "memory_writes_enabled": True,
                "memory_store": test_store,
                "owner_user_id": 1,
            },
        )
        people_after = test_store.get_people(1)
        assert len(people_after) == 1
        assert people_after[0]["name"] == "Steve"
        assert people_after[0]["handle"] == "my boss"
        assert people_after[0]["provisional"] == 0
    finally:
        test_store.close()
