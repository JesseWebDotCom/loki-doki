from __future__ import annotations

from lokidoki.core.decomposer import Ask
from lokidoki.core.memory_phase2 import (
    build_wake_up_context,
    bucket_memory_candidates,
    recent_injected_ids_from_traces,
    select_memory_context,
)


def _ask(**overrides) -> Ask:
    base = {
        "ask_id": "ask_1",
        "intent": "direct_chat",
        "distilled_query": "test",
    }
    base.update(overrides)
    return Ask(**base)


def test_bucket_assignment_separates_profile_relational_and_episodic_candidates():
    candidates = bucket_memory_candidates(
        facts=[
            {
                "id": 1,
                "subject": "self",
                "subject_type": "self",
                "predicate": "likes",
                "value": "coffee",
                "category": "preference",
                "kind": "preference",
                "confidence": 0.92,
                "status": "active",
                "source_message_id": 99,
            },
            {
                "id": 2,
                "subject": "artie",
                "subject_type": "person",
                "subject_ref_id": 12,
                "predicate": "likes",
                "value": "movies",
                "category": "preference",
                "kind": "fact",
                "confidence": 0.95,
                "status": "active",
            },
            {
                "id": 3,
                "subject": "vermont cabin trip",
                "subject_type": "entity",
                "predicate": "status",
                "value": "still in planning",
                "category": "event",
                "kind": "event",
                "confidence": 0.89,
                "status": "active",
            },
        ],
        past_messages=[
            {
                "id": 44,
                "session_id": 3,
                "content": "Let's pick back up on the cabin trip next week.",
                "created_at": "2026-04-01 12:00:00",
                "score": 0.8,
            }
        ],
        recent_message_ids={99},
        asks=[],
    )

    assert [f["id"] for f in candidates["working_context"]] == [1]
    assert [f["id"] for f in candidates["semantic_profile"]] == []
    assert [f["id"] for f in candidates["relational_graph"]] == [2]
    assert [f["id"] for f in candidates["episodic_threads"]] == [3]
    assert [m["id"] for m in candidates["episodic_messages"]] == [44]


def test_recent_injected_ids_collects_recent_facts_and_messages_from_traces():
    traces = [
        {
            "selected_injected_memories_json": {
                "facts_by_bucket": {
                    "semantic_profile": [{"id": 1}],
                    "relational_graph": [{"id": 2}],
                },
                "past_messages": [{"id": 9}],
            }
        },
        {
            "selected_injected_memories_json": {
                "facts_by_bucket": {
                    "episodic_threads": [{"id": 3}],
                },
                "past_messages": [{"id": 10}],
            }
        },
    ]

    repeated = recent_injected_ids_from_traces(traces)

    assert repeated["fact_ids"] == {1, 2, 3}
    assert repeated["message_ids"] == {9, 10}


def test_social_ack_budget_caps_memory_at_one_item():
    selection = select_memory_context(
        user_input="I like hiking",
        reply_mode="social_ack",
        memory_mode="sparse",
        asks=[],
        candidates_by_bucket={
            "working_context": [],
            "semantic_profile": [
                {
                    "id": 1,
                    "subject": "self",
                    "subject_type": "self",
                    "predicate": "likes",
                    "value": "coffee",
                    "category": "preference",
                    "kind": "preference",
                    "confidence": 0.9,
                    "status": "active",
                },
                {
                    "id": 2,
                    "subject": "self",
                    "subject_type": "self",
                    "predicate": "loves",
                    "value": "late-night walks",
                    "category": "preference",
                    "kind": "preference",
                    "confidence": 0.88,
                    "status": "active",
                },
            ],
            "relational_graph": [],
            "episodic_threads": [],
            "episodic_messages": [],
        },
        repeated_fact_ids=set(),
        repeated_message_ids=set(),
    )

    assert sum(len(v) for v in selection["facts_by_bucket"].values()) == 1
    assert selection["past_messages"] == []


def test_full_synthesis_budget_enforces_diversity_and_suppression():
    selection = select_memory_context(
        user_input="what should I remember about my brother and our cabin trip",
        reply_mode="full_synthesis",
        memory_mode="full",
        asks=[_ask(referent_type="person", referent_scope=["person"])],
        candidates_by_bucket={
            "working_context": [
                {
                    "id": 10,
                    "subject": "self",
                    "subject_type": "self",
                    "predicate": "likes",
                    "value": "coffee",
                    "category": "preference",
                    "kind": "preference",
                    "confidence": 0.94,
                    "status": "active",
                },
                {
                    "id": 11,
                    "subject": "self",
                    "subject_type": "self",
                    "predicate": "likes",
                    "value": "coffee",
                    "category": "preference",
                    "kind": "preference",
                    "confidence": 0.91,
                    "status": "active",
                },
            ],
            "semantic_profile": [
                {
                    "id": 12,
                    "subject": "self",
                    "subject_type": "self",
                    "predicate": "prefers",
                    "value": "quiet mornings",
                    "category": "preference",
                    "kind": "preference",
                    "confidence": 0.85,
                    "status": "active",
                }
            ],
            "relational_graph": [
                {
                    "id": 13,
                    "subject": "artie",
                    "subject_type": "person",
                    "subject_ref_id": 2,
                    "predicate": "likes",
                    "value": "movies",
                    "category": "preference",
                    "kind": "fact",
                    "confidence": 0.95,
                    "status": "active",
                },
                {
                    "id": 14,
                    "subject": "artie",
                    "subject_type": "person",
                    "subject_ref_id": 2,
                    "predicate": "birthday",
                    "value": "June 7",
                    "category": "biographical",
                    "kind": "fact",
                    "confidence": 0.2,
                    "status": "ambiguous",
                },
            ],
            "episodic_threads": [
                {
                    "id": 15,
                    "subject": "vermont cabin trip",
                    "subject_type": "entity",
                    "predicate": "status",
                    "value": "still in planning",
                    "category": "event",
                    "kind": "event",
                    "confidence": 0.86,
                    "status": "active",
                }
            ],
            "episodic_messages": [
                {
                    "id": 20,
                    "session_id": 7,
                    "content": "We should bring the blue cooler for the cabin trip.",
                    "created_at": "2026-04-01 12:00:00",
                    "score": 0.88,
                }
            ],
        },
        repeated_fact_ids={10},
        repeated_message_ids=set(),
    )

    chosen_fact_ids = {
        item["id"]
        for bucket in selection["facts_by_bucket"].values()
        for item in bucket
    }

    assert 10 not in chosen_fact_ids
    assert 11 not in chosen_fact_ids
    assert 14 not in chosen_fact_ids
    assert 13 in chosen_fact_ids
    assert 15 in chosen_fact_ids
    assert len(chosen_fact_ids) <= 4
    assert len(selection["past_messages"]) <= 1


def test_grounded_direct_without_referent_resolution_injects_no_memory():
    selection = select_memory_context(
        user_input="what's playing near me",
        reply_mode="grounded_direct",
        memory_mode="minimal",
        asks=[],
        candidates_by_bucket={
            "working_context": [{"id": 1}],
            "semantic_profile": [{"id": 2}],
            "relational_graph": [{"id": 3}],
            "episodic_threads": [{"id": 4}],
            "episodic_messages": [{"id": 5}],
        },
        repeated_fact_ids=set(),
        repeated_message_ids=set(),
    )

    assert selection["facts_by_bucket"] == {
        "working_context": [],
        "semantic_profile": [],
        "relational_graph": [],
        "episodic_threads": [],
    }
    assert selection["past_messages"] == []


def test_wake_up_context_caps_sections():
    wake = build_wake_up_context(
        facts_by_bucket={
            "working_context": [
                {"subject": "self", "subject_type": "self", "predicate": "likes", "value": "coffee"},
                {"subject": "self", "subject_type": "self", "predicate": "prefers", "value": "quiet mornings"},
                {"subject": "self", "subject_type": "self", "predicate": "collects", "value": "vinyl"},
            ],
            "semantic_profile": [
                {"subject": "self", "subject_type": "self", "predicate": "enjoys", "value": "stormy weather"},
            ],
            "relational_graph": [
                {"subject": "artie", "subject_type": "person", "predicate": "likes", "value": "movies"},
                {"subject": "cam", "subject_type": "person", "predicate": "likes", "value": "painting"},
            ],
            "episodic_threads": [
                {
                    "subject": "cabin trip",
                    "subject_type": "entity",
                    "predicate": "status",
                    "value": "still in planning",
                }
            ],
        },
        past_messages=[
            {
                "id": 9,
                "content": "Let's revisit the cabin trip packing list next weekend.",
                "created_at": "2026-04-01 12:00:00",
            },
            {
                "id": 10,
                "content": "Also remind me about the projector setup.",
                "created_at": "2026-04-02 12:00:00",
            },
        ],
    )

    assert len(wake["key_facts"]) == 2
    assert len(wake["relationships"]) == 1
    assert len(wake["threads"]) == 1
    assert "WAKE_UP_CONTEXT:" in wake["text"]
