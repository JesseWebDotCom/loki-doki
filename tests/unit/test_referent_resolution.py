import json
from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask
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


def test_enriched_ask_proxies_to_underlying_ask():
    ask = Ask(ask_id="a", intent="direct_chat", distilled_query="hello")
    enriched = EnrichedAsk(ask=ask)
    assert enriched.intent == "direct_chat"
    assert enriched.distilled_query == "hello"
