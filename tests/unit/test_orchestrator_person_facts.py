"""Pin: orchestrator must complete the full pipeline when the decomposer
emits person + relationship facts (the user's "my brother artie loves
movies" scenario). Catches regressions where persist or silent
confirmation emission stalls the synthesis path.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401  side-effect bind
from lokidoki.core import people_graph_sql as gql
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


PERSON_DECOMP = DecompositionResult(
    is_course_correction=False,
    overall_reasoning_complexity="fast",
    short_term_memory={"sentiment": "positive", "concern": ""},
    long_term_memory=[
        {
            "subject_type": "person", "subject_name": "Artie",
            "predicate": "loves", "value": "movies",
            "kind": "fact", "relationship_kind": None,
            "category": "preference", "negates_previous": False,
        },
        {
            "subject_type": "person", "subject_name": "Artie",
            "predicate": "is", "value": "brother",
            "kind": "relationship", "relationship_kind": "brother",
            "category": "relationship", "negates_previous": False,
        },
    ],
    asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="Acknowledge")],
    model="gemma4:e2b",
    latency_ms=120.0,
)

MOCK_REPLY = "Got it — noted."


def _make_stream(text: str):
    async def _gen(*_a, **_kw):
        for c in [text[i:i + 4] for i in range(0, len(text), 4)] or [""]:
            yield c
    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "p.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture
async def user_session(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    return uid, sid


@pytest.fixture
def orchestrator(memory):
    decomp = AsyncMock()
    decomp.decompose = AsyncMock(return_value=PERSON_DECOMP)
    inf = AsyncMock()
    inf.generate = AsyncMock(return_value=MOCK_REPLY)
    inf.generate_stream = _make_stream(MOCK_REPLY)
    return Orchestrator(
        decomposer=decomp,
        inference_client=inf,
        memory=memory,
        model_manager=ModelManager(inference_client=inf, policy=ModelPolicy(platform="mac")),
    )


@pytest.mark.anyio
async def test_full_pipeline_with_person_facts(orchestrator, user_session, memory):
    uid, sid = user_session
    events = []
    async for ev in orchestrator.process(
        "my brother artie loves movies", user_id=uid, session_id=sid
    ):
        events.append(ev)

    phases = [e.phase for e in events]
    # The whole pipeline must run to synthesis done.
    assert "augmentation" in phases
    assert "decomposition" in phases
    assert "synthesis" in phases
    syn_done = [e for e in events if e.phase == "synthesis" and e.status == "done"]
    assert syn_done, f"synthesis never completed; phases={phases}"
    assert syn_done[0].data["response"] == MOCK_REPLY

    # Silent confirmations must have been emitted for the two facts.
    confs = [e for e in events if e.phase == "silent_confirmation"]
    assert len(confs) >= 1, f"no silent_confirmation events; phases={phases}"

    # The person + facts must actually be in the DB.
    people = await memory.list_people(uid)
    assert any(p["name"] == "Artie" for p in people)
    artie = next(p for p in people if p["name"] == "Artie")
    facts = await memory.list_facts_about_person(uid, artie["id"])
    assert any(f["value"] == "movies" for f in facts)
    rels = await memory.list_relationships(uid)
    assert any(r["relation"] == "brother" and r["person_id"] == artie["id"] for r in rels)


@pytest.mark.anyio
async def test_person_overlay_and_event_fields_flow_into_people_graph(orchestrator, user_session, memory):
    uid, sid = user_session
    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[
            {
                "subject_type": "person",
                "subject_name": "Lena",
                "predicate": "birthday",
                "value": "May 1",
                "kind": "event",
                "category": "event",
                "person_bucket": "friends",
                "relationship_state": "former",
                "interaction_preference": "avoid",
                "event_type": "birthday",
                "event_date_precision": "day_month",
            }
        ],
        asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="ok")],
        model="gemma4:e2b",
        latency_ms=10,
    )
    orchestrator._decomposer.decompose = AsyncMock(return_value=decomp)
    async for _ in orchestrator.process("Lena's birthday is May 1 and avoid bringing her up", user_id=uid, session_id=sid):
        pass
    people = await memory.run_sync(
        lambda conn: conn.execute(
            "SELECT bucket FROM people WHERE name = 'Lena'"
        ).fetchone()
    )
    overlay = await memory.run_sync(
        lambda conn: conn.execute(
            "SELECT relationship_state, interaction_preference FROM person_overlays po "
            "JOIN people p ON p.id = po.person_id WHERE po.viewer_user_id = ? AND p.name = 'Lena'",
            (uid,),
        ).fetchone()
    )
    event = await memory.run_sync(
        lambda conn: conn.execute(
            "SELECT event_type, date_precision FROM person_events pe "
            "JOIN people p ON p.id = pe.person_id WHERE p.name = 'Lena'"
        ).fetchone()
    )
    assert people["bucket"] == "friends"
    assert overlay["relationship_state"] == "former"
    assert overlay["interaction_preference"] == "avoid"
    assert event["event_type"] == "birthday"


@pytest.mark.anyio
async def test_graph_relations_include_sibling_for_linked_user(memory):
    uid = await memory.get_or_create_user("default")

    def _seed(conn):
        me = gql.create_person_graph(conn, uid, name="Jesse", bucket="family")
        sibling = gql.create_person_graph(conn, uid, name="Artie", bucket="family")
        parent = gql.create_person_graph(conn, uid, name="Mom", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=me)
        gql.create_person_edge(
            conn, uid, from_person_id=me, to_person_id=parent, edge_type="child"
        )
        gql.create_person_edge(
            conn, uid, from_person_id=sibling, to_person_id=parent, edge_type="child"
        )

    await memory.run_sync(_seed)
    relations = await memory.run_sync(
        lambda conn: gql.list_user_graph_relations(conn, user_id=uid)
    )
    assert "- sibling: Artie" in relations
