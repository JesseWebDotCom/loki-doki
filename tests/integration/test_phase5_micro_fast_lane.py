"""Integration tests for Phase 5: Micro fast-lane for greetings and gratitude.

These tests exercise the full orchestrator pipeline to verify that
greeting and gratitude turns bypass the decomposer and route to
social_ack, while non-trivial turns still go through decomposition.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.micro_fast_lane import reset_template_cache
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


def _stream(text: str):
    async def _gen(*_a, **_kw):
        yield text
    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase5.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture(autouse=True)
def _reset_fast_lane_cache():
    reset_template_cache()
    yield
    reset_template_cache()


def _make_orchestrator(memory, mock_decomposer, mock_inference):
    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )


# ---- greetings bypass decomposer on the chat path --------------------------

@pytest.mark.anyio
async def test_hi_bypasses_decomposer(memory):
    """'hi' should hit the micro fast-lane, skip decomposition, and route to social_ack."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hey there!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    events = []
    async for event in orch.process("hi", user_id=uid, session_id=sid):
        events.append(event)

    # Decomposer should NOT have been called.
    mock_decomposer.decompose.assert_not_called()

    # Should have a micro_fast_lane event with hit=True.
    fl_events = [e for e in events if e.phase == "micro_fast_lane"]
    assert len(fl_events) == 1
    assert fl_events[0].data["hit"] is True
    assert fl_events[0].data["category"] == "greeting"

    # Synthesis should produce a response.
    done = next(e for e in events if e.phase == "synthesis" and e.status == "done")
    assert done.data["response"] == "Hey there!"
    assert done.data.get("micro_fast_lane") is True

    # Trace should record social_ack lane.
    traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
    assert traces[0]["response_lane_actual"] == "social_ack"


@pytest.mark.anyio
async def test_hey_bypasses_decomposer(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("What's good!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("hey", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


@pytest.mark.anyio
async def test_hello_bypasses_decomposer(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hello!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("hello", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


# ---- gratitude bypasses decomposer on the chat path ------------------------

@pytest.mark.anyio
async def test_thanks_bypasses_decomposer(memory):
    """'thanks' should hit the micro fast-lane as gratitude."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("You're welcome!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    events = []
    async for event in orch.process("thanks", user_id=uid, session_id=sid):
        events.append(event)

    mock_decomposer.decompose.assert_not_called()

    fl_events = [e for e in events if e.phase == "micro_fast_lane"]
    assert len(fl_events) == 1
    assert fl_events[0].data["category"] == "gratitude"

    traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
    assert traces[0]["response_lane_actual"] == "social_ack"


@pytest.mark.anyio
async def test_thank_you_bypasses_decomposer(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Anytime!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("thank you", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


# ---- non-trivial turns do NOT bypass ---------------------------------------

@pytest.mark.anyio
async def test_weather_question_does_not_bypass(memory):
    """'hey what's the weather' must go through the decomposer."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="what's the weather")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("It's sunny today.")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("hey what's the weather", user_id=uid, session_id=sid):
        pass

    # Decomposer SHOULD have been called.
    mock_decomposer.decompose.assert_called_once()


@pytest.mark.anyio
async def test_stressed_greeting_does_not_bypass(memory):
    """Emotional turns must go through decomposer for sentiment capture."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I'm stressed out")],
        short_term_memory={"sentiment": "frustrated", "concern": "stress"},
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("That sounds tough.")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("I'm stressed out", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_called_once()


@pytest.mark.anyio
async def test_emotional_hey_does_not_bypass(memory):
    """'hey I'm feeling sad' has emotional content — must not bypass."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I'm feeling sad")],
        short_term_memory={"sentiment": "sad", "concern": "sadness"},
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("I'm sorry to hear that.")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("hey I'm feeling sad", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_called_once()


# ---- regression: existing behavior unchanged --------------------------------

@pytest.mark.anyio
async def test_fact_sharing_still_routes_through_decomposer(memory):
    """'I like hiking' is not a greeting/gratitude — normal pipeline."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I like hiking")],
        long_term_memory=[{
            "subject_type": "self",
            "predicate": "likes",
            "value": "hiking",
            "kind": "preference",
            "category": "preference",
        }],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Nice! Do you go often?")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("I like hiking", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_called_once()


@pytest.mark.anyio
async def test_grounded_query_still_routes_through_decomposer(memory):
    """'who is the president' must go through decomposer."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="who is the president",
            requires_current_data=True,
        )],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("The current president is...")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("who is the president", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_called_once()


# ---- near-threshold inputs fall through safely ------------------------------

@pytest.mark.anyio
async def test_near_threshold_falls_through(memory):
    """An input near but below threshold must still go to decomposer."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    # "hey how are you" is greeting-adjacent but not an exact template match.
    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="how are you")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("I'm doing great!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    events = []
    async for event in orch.process("hey how are you doing today", user_id=uid, session_id=sid):
        events.append(event)

    # Should have gone through decomposer since it's not an exact match.
    mock_decomposer.decompose.assert_called_once()


# ---- realistic user-language variants ---------------------------------------

@pytest.mark.anyio
async def test_yo_bypasses(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Yo!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("yo", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


@pytest.mark.anyio
async def test_thx_bypasses(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("No problem!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("thx", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


@pytest.mark.anyio
async def test_good_morning_bypasses(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Good morning!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)
    async for _ in orch.process("good morning", user_id=uid, session_id=sid):
        pass

    mock_decomposer.decompose.assert_not_called()


# ---- multi-turn: fast-lane doesn't break subsequent turns -------------------

@pytest.mark.anyio
async def test_fast_lane_then_normal_turn(memory):
    """After a fast-lane greeting, a normal turn should go through decomposer."""
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="what's the weather")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Hey!")

    orch = _make_orchestrator(memory, mock_decomposer, mock_inference)

    # Turn 1: greeting — bypasses decomposer.
    async for _ in orch.process("hi", user_id=uid, session_id=sid):
        pass
    mock_decomposer.decompose.assert_not_called()

    # Turn 2: normal question — goes through decomposer.
    mock_inference.generate_stream = _stream("It's sunny.")
    async for _ in orch.process("what's the weather", user_id=uid, session_id=sid):
        pass
    mock_decomposer.decompose.assert_called_once()
