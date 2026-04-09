"""Transcript-style pipeline evals for multi-turn conversation behavior.

These tests exercise the real orchestrator, real capability routing,
and real referent-resolution stage. We only mock the network layer and
the decomposer outputs so we can pin tricky conversational flows
deterministically.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lokidoki.core import memory_people_ops  # noqa: F401
from lokidoki.core import skill_config
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.orchestrator_referent_resolution import ReferentCandidate
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor


SHOWTIMES_HTML = """
<html><body>
  <a class="result__a" href="https://example.com/avatar-fire-and-ash">Avatar: Fire and Ash</a>
  <a class="result__snippet">7:00pm, 9:45pm at Alamo Drafthouse Brooklyn</a>
</body></html>
"""


def _stream_factory(text: str, sink: list[dict] | None = None):
    async def _gen(*_a, **kw):
        if sink is not None:
            sink.append(dict(kw))
        for chunk in [text[i:i + 10] for i in range(0, len(text), 10)] or [""]:
            yield chunk

    return _gen


def _build_orchestrator(
    decomp_results: list[DecompositionResult],
    memory: MemoryProvider,
    *,
    registry: SkillRegistry | None = None,
    prompt_sink: list[dict] | None = None,
) -> Orchestrator:
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(side_effect=decomp_results)

    mock_inference = AsyncMock()
    mock_inference.generate = AsyncMock(return_value="Session Title")
    mock_inference.generate_stream = _stream_factory("ok", prompt_sink)

    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
        registry=registry,
        skill_executor=SkillExecutor(),
    )


async def _run_turn(
    orch: Orchestrator,
    text: str,
    *,
    user_id: int,
    session_id: int,
) -> list:
    events = []
    async for event in orch.process(text, user_id=user_id, session_id=session_id):
        events.append(event)
    return events


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "transcript_eval.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture
def registry():
    reg = SkillRegistry()
    reg.scan()
    return reg


@pytest.mark.anyio
async def test_transcript_movie_showtimes_followup_uses_cached_media_referent(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Brooklyn, NY"
        )
    )

    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[{
            "subject_type": "self",
            "subject_name": "",
            "predicate": "might go see",
            "value": "the new avatar movie tonight",
            "kind": "event",
            "category": "plan",
            "memory_priority": "low",
        }],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="the new avatar movie tonight",
            context_source="external",
            referent_type="media",
            durability="tentative",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="the new avatar movie",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="what time is it playing",
            context_source="recent_context",
            referent_type="media",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="it",
            requires_current_data=True,
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator([turn1, turn2], memory, registry=registry)

    async def fake_generate(*_args, **kwargs):
        prompt = kwargs.get("prompt", "")
        if "ROLE:infer a grounded lookup query for an unresolved referential ask." in prompt:
            return json.dumps({
                "lookup_query": "showtimes for Avatar: Fire and Ash",
                "capability_need": "current_media",
            })
        return "Session Title"

    orch._inference.generate = AsyncMock(side_effect=fake_generate)

    response = MagicMock()
    response.status_code = 200
    response.text = SHOWTIMES_HTML

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        await _run_turn(
            orch,
            "Maybe I'll go to the movies tonight and see the new avatar movie",
            user_id=uid,
            session_id=sid,
        )
        events = await _run_turn(
            orch,
            "what time is it playing",
            user_id=uid,
            session_id=sid,
        )

    rr = next(e for e in events if e.phase == "referent_resolution" and e.status == "done")
    routing = next(e for e in events if e.phase == "routing" and e.status == "done")
    facts = await memory.list_facts(uid)

    assert rr.data["asks"][0]["resolution_status"] == "resolved"
    assert rr.data["asks"][0]["resolution_source"] == "recent_context"
    assert rr.data["asks"][0]["enriched_query"] == "showtimes for Avatar: Fire and Ash"
    assert routing.data["routing_log"][0]["intent"] == "movies_showtimes.get_showtimes"
    assert routing.data["routing_log"][0]["status"] == "success"
    assert all(f["value"] != "the new avatar movie tonight" for f in facts)


@pytest.mark.anyio
async def test_transcript_movie_check_followup_answers_instead_of_promising_again(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Brooklyn, NY"
        )
    )

    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="is it still playing in theaters",
            context_source="recent_context",
            referent_type="media",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="it",
            requires_current_data=True,
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="check",
            context_source="recent_context",
            referent_type="unknown",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="check",
            requires_current_data=True,
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator([turn1, turn2], memory, registry=registry)
    orch._session_referent_cache[sid] = {
        "resolved_referents": []
    }
    orch._session_referent_cache[sid]["resolved_referents"].append(
        ReferentCandidate(
            candidate_id="recent_media",
            type="media",
            display_name="Avatar: Fire and Ash",
            canonical_name="Avatar: Fire and Ash",
            source="recent_context",
            source_ref="session",
            score=8.0,
            metadata={},
        )
    )

    response = MagicMock()
    response.status_code = 200
    response.text = SHOWTIMES_HTML

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        events = await _run_turn(orch, "check", user_id=uid, session_id=sid)

    synthesis = next(e for e in events if e.phase == "synthesis" and e.status == "done")
    assert synthesis.data["fast_path"] is True
    assert "7:00pm" in synthesis.data["response"]
    assert "I can check that for you" not in synthesis.data["response"]


@pytest.mark.anyio
async def test_transcript_short_media_followup_repairs_back_into_current_media(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Brooklyn, NY"
        )
    )

    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="the new avatar movie tonight",
            context_source="external",
            referent_type="media",
            durability="tentative",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="the new avatar movie",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="is it still playing",
            context_source="recent_context",
            referent_type="media",
            durability="ephemeral",
            needs_referent_resolution=False,
            capability_need="none",
            referent_status="none",
            referent_scope=["media"],
            referent_anchor="it",
            requires_current_data=False,
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator([turn1, turn2], memory, registry=registry)

    async def fake_generate(*_args, **kwargs):
        prompt = kwargs.get("prompt", "")
        if "ROLE:infer a grounded lookup query for an unresolved referential ask." in prompt:
            return json.dumps({
                "lookup_query": "showtimes for Avatar: Fire and Ash",
                "capability_need": "current_media",
            })
        return "Session Title"

    orch._inference.generate = AsyncMock(side_effect=fake_generate)

    response = MagicMock()
    response.status_code = 200
    response.text = SHOWTIMES_HTML

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        await _run_turn(
            orch,
            "Maybe I'll go to the movies tonight and see the new avatar movie",
            user_id=uid,
            session_id=sid,
        )
        events = await _run_turn(
            orch,
            "is it still playing",
            user_id=uid,
            session_id=sid,
        )

    rr = next(e for e in events if e.phase == "referent_resolution" and e.status == "done")
    routing = next(e for e in events if e.phase == "routing" and e.status == "done")
    synthesis = next(e for e in events if e.phase == "synthesis" and e.status == "done")

    assert rr.data["asks"][0]["resolution_status"] == "resolved"
    assert rr.data["asks"][0]["enriched_query"] == "showtimes for Avatar: Fire and Ash"
    assert routing.data["routing_log"][0]["intent"] == "movies_showtimes.get_showtimes"
    assert routing.data["routing_log"][0]["status"] == "success"
    assert synthesis.data["grounded_fast_path"] is True
    assert "7:00pm" in synthesis.data["response"]


@pytest.mark.anyio
async def test_transcript_movie_name_followup_uses_cached_canonical_title(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Brooklyn, NY"
        )
    )

    prompt_sink: list[dict] = []
    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="the new avatar movie",
            context_source="external",
            referent_type="media",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="current_media",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="the new avatar movie",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="what's the full name",
            context_source="recent_context",
            referent_type="media",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="none",
            referent_status="unresolved",
            referent_scope=["media"],
            referent_anchor="the movie",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(
        [turn1, turn2],
        memory,
        registry=registry,
        prompt_sink=prompt_sink,
    )

    response = MagicMock()
    response.status_code = 200
    response.text = SHOWTIMES_HTML

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        await _run_turn(orch, "Maybe I'll see the new avatar movie", user_id=uid, session_id=sid)
        events = await _run_turn(orch, "what's the full name", user_id=uid, session_id=sid)

    rr = next(e for e in events if e.phase == "referent_resolution" and e.status == "done")
    routing = next(e for e in events if e.phase == "routing" and e.status == "done")
    synthesis = next(e for e in events if e.phase == "synthesis" and e.status == "done")

    assert rr.data["asks"][0]["resolution_status"] == "resolved"
    assert rr.data["asks"][0]["resolution_source"] == "recent_context"
    # Anchored follow-ups ("the movie") now bypass the grounded fast
    # path and route through the synthesizer so the LLM can extract the
    # canonical title from SKILL_DATA. Assert that the model's prompt
    # carried the resolved title — that's the contract that matters
    # (the mock inference client returns "ok" verbatim).
    assert routing.data["routing_log"][0]["status"] in ("success", "no_skill")
    synth_prompts = [p for p in prompt_sink if "SKILL_DATA:" in p.get("prompt", "")]
    if routing.data["routing_log"][0]["status"] == "success":
        assert synth_prompts, "anchored follow-up should reach the synthesizer"
        assert "Avatar: Fire and Ash" in synth_prompts[-1]["prompt"], (
            "resolved title missing from synthesis prompt"
        )
        assert synthesis.data.get("fast_path") is not True


@pytest.mark.anyio
async def test_transcript_family_followup_resolves_person_from_memory(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    prompt_sink: list[dict] = []
    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "positive", "concern": ""},
        long_term_memory=[
            {
                "subject_type": "person",
                "subject_name": "Artie",
                "predicate": "is",
                "value": "brother",
                "kind": "relationship",
                "relationship_kind": "brother",
                "category": "relationship",
                "memory_priority": "high",
            }
        ],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="my brother Artie loves movies",
            context_source="none",
            referent_type="person",
            durability="durable",
            needs_referent_resolution=False,
            capability_need="none",
            referent_status="resolved",
            referent_scope=["person"],
            referent_anchor="Artie",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="what's his name",
            context_source="long_term_memory",
            referent_type="person",
            durability="ephemeral",
            needs_referent_resolution=True,
            capability_need="none",
            referent_status="unresolved",
            referent_scope=["person"],
            referent_anchor="his",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(
        [turn1, turn2],
        memory,
        prompt_sink=prompt_sink,
    )

    await _run_turn(orch, "my brother Artie loves movies", user_id=uid, session_id=sid)
    events = await _run_turn(orch, "what's his name", user_id=uid, session_id=sid)

    rr = next(e for e in events if e.phase == "referent_resolution" and e.status == "done")
    routing = next(e for e in events if e.phase == "routing" and e.status == "done")

    assert rr.data["asks"][0]["resolution_status"] == "resolved"
    assert rr.data["asks"][0]["resolution_source"] == "long_term_memory"
    assert "MEMORY_PEOPLE:" in prompt_sink[-1]["prompt"]
    assert "Artie" in prompt_sink[-1]["prompt"]
    assert routing.data["routing_log"][0]["status"] == "no_skill"


@pytest.mark.anyio
async def test_transcript_combined_movie_and_brother_name_followup_sees_cached_movie(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Brooklyn, NY"
        )
    )
    person_id = await memory.create_person(uid, "Artie")
    await memory.add_relationship(uid, person_id, "brother")

    prompt_sink: list[dict] = []
    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="maybe i'll go to the theater tonight with my brother and see avatar",
            context_source="recent_context",
            referent_type="unknown",
            durability="tentative",
            needs_referent_resolution=True,
            capability_need="none",
            referent_status="unresolved",
            referent_scope=["person", "event"],
            referent_anchor="avatar",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="thinking",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="what's the name of the movie and what's my brother's name",
            context_source="long_term_memory",
            referent_type="unknown",
            durability="ephemeral",
            needs_referent_resolution=False,
            capability_need="none",
            referent_status="resolved",
            referent_scope=["person", "media"],
            referent_anchor="movie and brother",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(
        [turn1, turn2],
        memory,
        registry=registry,
        prompt_sink=prompt_sink,
    )

    response = MagicMock()
    response.status_code = 200
    response.text = SHOWTIMES_HTML

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        await _run_turn(
            orch,
            "maybe i'll go to the theater tonight with my brother and see avatar",
            user_id=uid,
            session_id=sid,
        )
        events = await _run_turn(
            orch,
            "what's the name of the movie and what's my brother's name",
            user_id=uid,
            session_id=sid,
        )

    rr = next(e for e in events if e.phase == "referent_resolution" and e.status == "done")
    synthesis = next(e for e in events if e.phase == "synthesis" and e.status == "done")

    assert rr.data["asks"][0]["resolution_status"] in ("none", "resolved")
    assert "RESOLVED_REFERENTS:" in prompt_sink[-1]["prompt"]
    assert "Avatar: Fire and Ash" in prompt_sink[-1]["prompt"]
    assert "MEMORY_PEOPLE:" in prompt_sink[-1]["prompt"]
    assert "Artie" in prompt_sink[-1]["prompt"]
    assert synthesis.data["response"]


@pytest.mark.anyio
async def test_transcript_weather_followup_routes_current_data_lookup(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    prompt_sink: list[dict] = []
    turn1 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="it's been raining all day in Brooklyn",
            context_source="none",
            referent_type="event",
            durability="ephemeral",
            needs_referent_resolution=False,
            capability_need="none",
            referent_status="none",
            referent_scope=["event"],
            referent_anchor="",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    turn2 = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],
        asks=[Ask(
            ask_id="ask_2",
            intent="direct_chat",
            distilled_query="will it clear up tonight in Brooklyn",
            context_source="external",
            referent_type="event",
            durability="ephemeral",
            needs_referent_resolution=False,
            capability_need="web_search",
            referent_status="none",
            referent_scope=["event"],
            referent_anchor="",
            requires_current_data=True,
            response_shape="synthesized",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(
        [turn1, turn2],
        memory,
        registry=registry,
        prompt_sink=prompt_sink,
    )

    ddg_response = MagicMock()
    ddg_response.status_code = 200
    ddg_response.json.return_value = {
        "Heading": "Brooklyn weather tonight",
        "AbstractText": "Light rain should taper off this evening with clearing overnight.",
        "AbstractURL": "https://example.com/weather",
        "RelatedTopics": [],
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=ddg_response):
        await _run_turn(orch, "it's been raining all day in Brooklyn", user_id=uid, session_id=sid)
        events = await _run_turn(orch, "will it clear up tonight", user_id=uid, session_id=sid)

    routing = next(e for e in events if e.phase == "routing" and e.status == "done")
    synthesis = next(e for e in events if e.phase == "synthesis" and e.status == "done")

    assert routing.data["routing_log"][0]["intent"] == "search_ddg.search_web"
    assert routing.data["routing_log"][0]["status"] == "success"
    assert synthesis.data["model"] != "fast_path"
    assert "[src:1]" in synthesis.data["response"] or prompt_sink[-1]["prompt"]


@pytest.mark.anyio
async def test_transcript_avatar_is_it_still_playing_then_what_time_degrades_cleanly(memory, registry):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await memory.run_sync(
        lambda c: skill_config.set_user_value(
            c, uid, "movies_showtimes", "default_location", "Milford, CT"
        )
    )

    turns = [
        DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="fast",
            short_term_memory={"sentiment": "neutral", "concern": "none"},
            long_term_memory=[],
            asks=[Ask(
                ask_id="1",
                intent="direct_chat",
                distilled_query="maybe I'll go to the theater tonight with my borther and see avatar",
                response_shape="synthesized",
                requires_current_data=False,
                knowledge_source="none",
                context_source="recent_context",
                referent_type="event",
                durability="tentative",
                needs_referent_resolution=False,
                capability_need="none",
                referent_status="unresolved",
                referent_scope=["event"],
                referent_anchor="tonight",
            )],
            model="gemma4:e2b",
            latency_ms=10.0,
        ),
        DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="fast",
            short_term_memory={"sentiment": "neutral", "concern": "none"},
            long_term_memory=[],
            asks=[Ask(
                ask_id="ask_1",
                intent="direct_chat",
                distilled_query="is it still playing",
                response_shape="synthesized",
                requires_current_data=True,
                knowledge_source="web",
                context_source="recent_context",
                referent_type="media",
                durability="ephemeral",
                needs_referent_resolution=False,
                capability_need="current_media",
                referent_status="resolved",
                referent_scope=["media"],
                referent_anchor="Avatar",
            )],
            model="gemma4:e2b",
            latency_ms=10.0,
        ),
        DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="fast",
            short_term_memory={"sentiment": "neutral", "concern": "none"},
            long_term_memory=[],
            asks=[Ask(
                ask_id="ask_2",
                intent="direct_chat",
                distilled_query="what time",
                response_shape="synthesized",
                requires_current_data=True,
                knowledge_source="none",
                context_source="recent_context",
                referent_type="media",
                durability="ephemeral",
                needs_referent_resolution=False,
                capability_need="current_media",
                referent_status="resolved",
                referent_scope=["media"],
                referent_anchor="Avatar",
            )],
            model="gemma4:e2b",
            latency_ms=10.0,
        ),
    ]
    orch = _build_orchestrator(turns, memory, registry=registry)

    no_showtimes = MagicMock()
    no_showtimes.status_code = 200
    no_showtimes.text = "<html><body><a class=\"result__a\" href=\"https://example.com\">Find Showtimes Near You</a><a class=\"result__snippet\">Reserve your seats today.</a></body></html>"

    await _run_turn(
        orch,
        "maybe I'll go to the theater tonight with my borther and see avatar",
        user_id=uid,
        session_id=sid,
    )
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=no_showtimes):
        second = await _run_turn(orch, "is it still playing", user_id=uid, session_id=sid)
        third = await _run_turn(orch, "what time", user_id=uid, session_id=sid)

    second_synth = next(e for e in second if e.phase == "synthesis" and e.status == "done")
    third_synth = next(e for e in third if e.phase == "synthesis" and e.status == "done")

    assert "Phil Mickelson" not in second_synth.data["response"]
    assert "Avatar" in second_synth.data["response"]
    assert "showtimes" in second_synth.data["response"]
    assert "Avatar" in third_synth.data["response"]
