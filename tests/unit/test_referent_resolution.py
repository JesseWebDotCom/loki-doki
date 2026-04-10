import json
from unittest.mock import AsyncMock

import pytest

from lokidoki.core import people_graph_sql as gql
from lokidoki.core.decomposer import Ask
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator_referent_resolution import (
    EnrichedAsk,
    ReferentCandidate,
    ReferentResolver,
)


@pytest.fixture
def resolver():
    inference = AsyncMock()
    policy = ModelPolicy(platform="mac")
    return ReferentResolver(
        inference_client=inference,
        model_manager=ModelManager(inference_client=inference, policy=policy),
        registry=None,
        executor=None,
    )


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "referent_resolution.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_recent_context_media_candidate_beats_older_memory(resolver):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="what time is it playing",
        referent_type="media",
        needs_referent_resolution=True,
        capability_need="current_media",
    )
    session_cache = {
        "resolved_referents": [
            ReferentCandidate(
                candidate_id="recent_media",
                type="media",
                display_name="Avatar: Fire and Ash",
                canonical_name="Avatar: Fire and Ash",
                source="recent_context",
                source_ref="session",
                score=0.0,
                metadata={},
            )
        ]
    }
    relevant_facts = [{
        "subject": "avatar",
        "subject_type": "entity",
        "predicate": "is",
        "value": "a movie",
        "confidence": 0.9,
    }]

    resolved = await resolver.resolve_asks(
        user_input="what time is it playing",
        asks=[ask],
        recent=[],
        relevant_facts=relevant_facts,
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=["Avatar: Fire and Ash"],
        session_cache=session_cache,
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Avatar: Fire and Ash"
    assert enriched.enriched_query == "showtimes for Avatar: Fire and Ash"


@pytest.mark.anyio
async def test_capability_lookup_can_resolve_media_when_retrieval_is_weak(resolver, monkeypatch):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="the new avatar movie",
        referent_type="media",
        needs_referent_resolution=True,
        capability_need="current_media",
    )

    async def fake_lookup(*args, **kwargs):
        return {
            "intent": "movies_showtimes.get_showtimes",
            "data": {
                "title": "Avatar: Fire and Ash",
                "lead": "Avatar: Fire and Ash showtimes.",
            },
            "source": "capability_lookup",
        }

    monkeypatch.setattr(
        "lokidoki.core.orchestrator_referent_resolution.execute_capability_lookup",
        fake_lookup,
    )

    resolved = await resolver.resolve_asks(
        user_input="the new avatar movie",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.source == "capability_lookup"
    assert enriched.enriched_query == "showtimes for Avatar: Fire and Ash"


@pytest.mark.anyio
async def test_ambiguous_candidates_trigger_fast_model_fallback(resolver):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="what's his name",
        referent_type="person",
        needs_referent_resolution=True,
        capability_need="none",
    )
    resolver._inference.generate = AsyncMock(return_value=json.dumps({
        "chosen_candidate_id": "cand_b",
        "clarification_hint": "",
    }))
    candidates = [
        ReferentCandidate("cand_a", "person", "Mark", "Mark", "recent_context", "a", 5.1, {}),
        ReferentCandidate("cand_b", "person", "Artie", "Artie", "long_term_memory", "b", 5.0, {}),
    ]

    enriched = await resolver._resolve_with_fallback(
        user_input="what's his name",
        ask=ask,
        candidates=candidates,
        recent=[],
    )

    assert enriched.status == "resolved"
    assert enriched.chosen_candidate.canonical_name == "Artie"
    resolver._inference.generate.assert_awaited_once()
    assert resolver._inference.generate.call_args.kwargs["model"] == resolver._model_manager.policy.fast_model


@pytest.mark.anyio
async def test_unresolved_after_fallback_requests_clarification(resolver):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="what time is it playing",
        referent_type="media",
        needs_referent_resolution=True,
        capability_need="current_media",
    )
    resolver._inference.generate = AsyncMock(return_value=json.dumps({
        "chosen_candidate_id": "",
        "clarification_hint": "Which movie do you mean?",
    }))

    resolution = await resolver._resolve_with_fallback(
        user_input="what time is it playing",
        ask=ask,
        candidates=[],
        recent=[],
    )

    assert resolution.status == "unresolved"
    assert resolution.clarification_hint == "Which movie do you mean?"


@pytest.mark.anyio
async def test_anchor_based_media_resolution_upgrades_capability_when_initial_hint_is_weak(
    resolver, monkeypatch
):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="maybe i'll go to the theater tonight with my brother and see avatar",
        referent_type="media",
        durability="tentative",
        context_source="recent_context",
        needs_referent_resolution=True,
        capability_need="none",
        referent_status="unresolved",
        # The decomposer prompt now instructs the model to tag scope=
        # ["media"] for "see Avatar tonight"-style asks. The anchor-
        # capabilities path only fires for media-typed asks (preventing
        # the bug where every tentative+anchor combo hit the showtimes
        # provider). See orchestrator_referent_resolution._anchor_capability_candidates.
        referent_scope=["media"],
        referent_anchor="avatar",
    )

    async def fake_lookup(*args, **kwargs):
        if kwargs.get("category") != "current_media":
            return None
        return {
            "intent": "movies_showtimes.get_showtimes",
            "data": {
                "title": "Avatar: Fire and Ash",
                "lead": "Avatar: Fire and Ash showtimes.",
            },
            "source": "capability_lookup",
        }

    monkeypatch.setattr(
        "lokidoki.core.orchestrator_referent_resolution.execute_capability_lookup",
        fake_lookup,
    )

    resolved = await resolver.resolve_asks(
        user_input=ask.distilled_query,
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.source == "capability_lookup"
    assert enriched.ask.capability_need == "current_media"
    assert enriched.ask.requires_current_data is True
    assert enriched.enriched_query == "showtimes for Avatar: Fire and Ash"


@pytest.mark.anyio
async def test_anchor_based_product_resolution_can_use_web_search_capability(
    resolver, monkeypatch
):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="is the new playstation headset worth it",
        referent_type="unknown",
        context_source="external",
        needs_referent_resolution=True,
        capability_need="none",
        referent_status="unresolved",
        referent_scope=["product"],
        referent_anchor="playstation headset",
    )

    async def fake_lookup(*args, **kwargs):
        if kwargs.get("category") != "web_search":
            return None
        return {
            "intent": "search_ddg.search_web",
            "data": {
                "heading": "PlayStation VR2",
                "abstract": "Sony's PlayStation VR2 headset for PS5.",
            },
            "source": "capability_lookup",
        }

    monkeypatch.setattr(
        "lokidoki.core.orchestrator_referent_resolution.execute_capability_lookup",
        fake_lookup,
    )

    resolved = await resolver.resolve_asks(
        user_input=ask.distilled_query,
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "PlayStation VR2"


@pytest.mark.anyio
async def test_recent_context_place_candidate_resolves_followup_without_llm(resolver):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="what's the address",
        referent_type="unknown",
        context_source="recent_context",
        needs_referent_resolution=True,
        capability_need="none",
        referent_status="unresolved",
        referent_scope=["place"],
        referent_anchor="there",
    )
    session_cache = {
        "resolved_referents": [
            ReferentCandidate(
                candidate_id="recent_place",
                type="entity",
                display_name="Alamo Drafthouse Brooklyn",
                canonical_name="Alamo Drafthouse Brooklyn",
                source="recent_context",
                source_ref="session",
                score=0.0,
                metadata={},
            )
        ]
    }

    resolved = await resolver.resolve_asks(
        user_input=ask.distilled_query,
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache=session_cache,
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Alamo Drafthouse Brooklyn"


@pytest.mark.anyio
async def test_tentative_unresolved_turn_forces_resolution_even_without_explicit_flag(
    resolver, monkeypatch
):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="maybe i'll go to the theater tonight with my brother and see avatar",
        referent_type="media",
        context_source="recent_context",
        durability="tentative",
        needs_referent_resolution=False,
        capability_need="none",
        referent_status="unresolved",
        # Decomposer is expected to tag scope=["media"] when the user
        # mentions a named movie inside a tentative plan. The forced-
        # resolution gate only fires for groundable scopes (media/entity/
        # place/product) — bare events like "tonight" no longer trigger
        # speculative DDG calls on direct_chat.
        referent_scope=["media"],
        referent_anchor="avatar",
    )

    async def fake_lookup(*args, **kwargs):
        if kwargs.get("category") != "current_media":
            return None
        return {
            "intent": "movies_showtimes.get_showtimes",
            "data": {
                "title": "Avatar: Fire and Ash",
                "lead": "Avatar: Fire and Ash showtimes.",
            },
            "source": "capability_lookup",
        }

    monkeypatch.setattr(
        "lokidoki.core.orchestrator_referent_resolution.execute_capability_lookup",
        fake_lookup,
    )

    resolved = await resolver.resolve_asks(
        user_input=ask.distilled_query,
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.ask.capability_need == "current_media"
    assert enriched.enriched_query == "showtimes for Avatar: Fire and Ash"


@pytest.mark.anyio
async def test_chitchat_with_event_scope_does_not_force_external_lookup(
    resolver, monkeypatch
):
    """Pins the fix for the original ``Avatar tonight`` bug.

    When the decomposer tags an ask as direct_chat with capability_need=
    none and a non-groundable scope (just person/event, no media), the
    referent resolver MUST NOT force resolution. Forcing it used to fire
    speculative DDG searches on every chitchat sentence containing the
    word "tonight". CLAUDE.md's Skills-First, LLM-Last principle says
    bad routing degrades to direct_chat synthesis — never to wasted
    external calls. If any capability lookup fires here, fail loudly.
    """
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="maybe i'll go with my brother tonight",
        referent_type="event",
        context_source="external",
        durability="tentative",
        needs_referent_resolution=False,
        capability_need="none",
        referent_status="unresolved",
        referent_scope=["person", "event"],
        referent_anchor="tonight",
    )

    lookup_calls: list[dict] = []

    async def fake_lookup(*args, **kwargs):
        lookup_calls.append(kwargs)
        return None

    async def fake_infer_lookup_query(*args, **kwargs):
        raise AssertionError(
            "infer_lookup_query must not be called for non-groundable chitchat"
        )

    monkeypatch.setattr(resolver, "_infer_lookup_query", fake_infer_lookup_query)
    monkeypatch.setattr(
        "lokidoki.core.orchestrator_referent_resolution.execute_capability_lookup",
        fake_lookup,
    )

    resolved = await resolver.resolve_asks(
        user_input="maybe i'll go to the theater tonight with my brother and see avatar",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    # Resolution is skipped entirely — the ask falls through to direct_chat.
    assert enriched.resolution.status == "none"
    assert enriched.ask.capability_need == "none"
    assert enriched.enriched_query == ""
    # And critically: zero external lookups were attempted.
    assert lookup_calls == []


@pytest.mark.anyio
async def test_short_media_followup_forces_resolution_and_repairs_capability_from_session_context(
    resolver, monkeypatch
):
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="is it still playing",
        response_shape="synthesized",
        referent_type="media",
        context_source="recent_context",
        durability="ephemeral",
        needs_referent_resolution=False,
        capability_need="none",
        referent_status="none",
        referent_scope=["media"],
        referent_anchor="it",
    )
    session_cache = {
        "resolved_referents": [
            ReferentCandidate(
                candidate_id="recent_media",
                type="media",
                display_name="Avatar: Fire and Ash",
                canonical_name="Avatar: Fire and Ash",
                source="capability_lookup",
                source_ref="movies_showtimes.get_showtimes",
                score=0.0,
                metadata={
                    "lookup": {
                        "intent": "movies_showtimes.get_showtimes",
                    }
                },
            )
        ]
    }

    async def fake_infer_lookup_query(*args, **kwargs):
        return {
            "lookup_query": "showtimes for Avatar: Fire and Ash",
            "capability_need": "current_media",
        }

    monkeypatch.setattr(resolver, "_infer_lookup_query", fake_infer_lookup_query)

    resolved = await resolver.resolve_asks(
        user_input="is it still playing",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache=session_cache,
        user_id=1,
        memory=None,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Avatar: Fire and Ash"
    assert enriched.ask.capability_need == "current_media"
    assert enriched.ask.requires_current_data is True
    assert enriched.enriched_query == "showtimes for Avatar: Fire and Ash"


@pytest.mark.anyio
async def test_rapidfuzz_alias_matching_resolves_person_alias(resolver, memory):
    uid = await memory.get_or_create_user("default")

    def _seed(conn):
        gql.create_person_graph(
            conn,
            uid,
            name="Anthony Johnson",
            bucket="friends",
            aliases=["AJ", "Ant"],
        )

    await memory.run_sync(_seed)

    ask = Ask(
        ask_id="ask_alias",
        intent="direct_chat",
        distilled_query="check in with aj",
        referent_type="person",
        needs_referent_resolution=True,
        referent_anchor="aj",
    )

    resolved = await resolver.resolve_asks(
        user_input="check in with aj",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=uid,
        memory=memory,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Anthony Johnson"


@pytest.mark.anyio
async def test_graph_walk_resolves_arties_wife(resolver, memory):
    uid = await memory.get_or_create_user("default")

    def _seed(conn):
        artie = gql.create_person_graph(conn, uid, name="Artie", bucket="family")
        mira = gql.create_person_graph(conn, uid, name="Mira", bucket="family")
        gql.create_person_edge(
            conn,
            uid,
            from_person_id=artie,
            to_person_id=mira,
            edge_type="spouse",
        )

    await memory.run_sync(_seed)

    ask = Ask(
        ask_id="ask_graph_1",
        intent="direct_chat",
        distilled_query="how is artie's wife doing",
        referent_type="person",
        needs_referent_resolution=True,
        referent_anchor="Artie's wife",
    )

    resolved = await resolver.resolve_asks(
        user_input="how is artie's wife doing",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=uid,
        memory=memory,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Mira"


@pytest.mark.anyio
async def test_graph_walk_resolves_my_brothers_daughter(resolver, memory):
    uid = await memory.get_or_create_user("jesse")

    def _seed(conn):
        me = gql.create_person_graph(conn, uid, name="Jesse", bucket="family")
        artie = gql.create_person_graph(conn, uid, name="Artie", bucket="family")
        nora = gql.create_person_graph(conn, uid, name="Nora", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=me)
        gql.create_person_edge(
            conn,
            uid,
            from_person_id=me,
            to_person_id=artie,
            edge_type="brother",
        )
        gql.create_person_edge(
            conn,
            uid,
            from_person_id=artie,
            to_person_id=nora,
            edge_type="daughter",
        )

    await memory.run_sync(_seed)

    ask = Ask(
        ask_id="ask_graph_2",
        intent="direct_chat",
        distilled_query="how old is my brother's daughter",
        referent_type="person",
        needs_referent_resolution=True,
        referent_anchor="my brother's daughter",
    )

    resolved = await resolver.resolve_asks(
        user_input="how old is my brother's daughter",
        asks=[ask],
        recent=[],
        relevant_facts=[],
        past_messages=[],
        people=[],
        relationships=[],
        known_entities=[],
        session_cache={},
        user_id=uid,
        memory=memory,
    )

    enriched = resolved[0]
    assert enriched.resolution.status == "resolved"
    assert enriched.resolution.chosen_candidate.canonical_name == "Nora"


def test_enriched_ask_proxies_to_underlying_ask():
    ask = Ask(ask_id="a", intent="direct_chat", distilled_query="hello")
    enriched = EnrichedAsk(ask=ask)
    assert enriched.intent == "direct_chat"
    assert enriched.distilled_query == "hello"
