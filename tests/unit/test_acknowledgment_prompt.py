"""Tests for the acknowledgment-mode prompt and the orchestrator's
fact-sharing turn detection. The point of these tests is to PIN that
when the user shares a fact:

1. The orchestrator picks the few-shot acknowledgment template
   (not the general synthesis template).
2. The token cap drops to ACKNOWLEDGMENT_NUM_PREDICT.
3. The prompt contains the positive few-shot examples and the
   BANNED block — these are what stop a 2B model from parroting.

We can't unit-test that gemma actually obeys; what we CAN test is that
the right prompt is chosen and the right cap is applied.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401  side-effect bind
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import (
    ACKNOWLEDGMENT_NUM_PREDICT,
    SYNTHESIS_NUM_PREDICT,
    Orchestrator,
)
from lokidoki.core.orchestrator_skills import (
    build_acknowledgment_prompt,
)


class TestAckPromptShape:
    def test_contains_warm_positive_examples(self):
        p = build_acknowledgment_prompt(query="my brother luke loves movies")
        # Reaction words that signal warmth.
        assert "Aww" in p
        # Bot self-disclosure (sharing its own take).
        assert "I'm a total sucker" in p
        # Follow-up question pattern.
        assert "?" in p
        # Section header for the few-shot block.
        assert "examples of the warm" in p

    def test_contains_personality_block(self):
        """The bot's interests must be injected so it can self-disclose."""
        p = build_acknowledgment_prompt(query="my brother luke loves movies")
        assert "YOUR PERSONALITY" in p
        assert "movies" in p  # default BOT_INTERESTS

    def test_personality_overridable(self):
        p = build_acknowledgment_prompt(
            query="I love rock climbing",
            interests="rock climbing, bouldering, and trail running",
        )
        assert "rock climbing" in p

    def test_user_query_not_duplicated_in_fewshot(self):
        """REGRESSION: a 2B model mode-collapses to empty output when its
        actual query is also a few-shot example. The user query must
        appear ONLY in the final generation slot, never in the demos.

        Pins the bug from the live test where 'my brother luke loves
        movies' was both the first GOOD example and the actual query,
        causing synthesis to return empty for 1.77s.
        """
        query = "my brother luke loves movies"
        p = build_acknowledgment_prompt(query=query)
        # Split at the final generation marker; the few-shot section is
        # everything before it.
        parts = p.split("Now respond")
        assert len(parts) == 2, "prompt must have a single generation slot"
        fewshot_section = parts[0]
        assert query not in fewshot_section, (
            f"user query must not appear in few-shot examples; "
            f"this causes 2B models to mode-collapse"
        )
        # And the query DOES appear in the generation slot.
        assert query in parts[1]

    def test_no_banned_block_adjacent_to_generation_slot(self):
        """REGRESSION: a 'BANNED' block immediately before the model's
        turn confuses small models. The current prompt should be
        positive-only — the BANNED-STARTS rule is fine as a one-liner."""
        p = build_acknowledgment_prompt(query="my brother luke loves movies")
        # The string "← BANNED" is the failure pattern from the previous
        # version. It must not appear anywhere.
        assert "← BANNED" not in p

    def test_does_not_include_skill_data_or_context(self):
        p = build_acknowledgment_prompt(query="my brother luke loves movies")
        assert "SKILL_DATA" not in p
        assert "CONTEXT:" not in p

    def test_includes_clarify_followup_when_hint_present(self):
        p = build_acknowledgment_prompt(
            query="luke loves movies",
            clarify_hint="Ask which Luke they mean.",
        )
        assert "FOLLOWUP" in p
        assert "Ask which Luke" in p

    def test_includes_referent_context_when_names_provided(self):
        """When session cache has resolved referents, their names must
        appear in a CONTEXT block so the 2B model can use them."""
        p = build_acknowledgment_prompt(
            query="I like his new horror movies",
            referent_names=["Jordan Peele"],
        )
        assert "CONTEXT:" in p
        assert "Jordan Peele" in p

    def test_no_referent_context_when_names_empty(self):
        p = build_acknowledgment_prompt(query="I love coffee")
        assert "CONTEXT:" not in p

    def test_diverse_few_shot_relations(self):
        """Examples must cover varied relationships so the model can
        generalize, not memorize. No two examples should use the same
        relationship word."""
        p = build_acknowledgment_prompt(query="anything")
        relations = ["sister", "puppy", "dad", "bakery", "friend"]
        for r in relations:
            assert r in p, f"missing diverse example with '{r}'"


# --- Orchestrator routing test --------------------------------------------


PERSON_FACT_DECOMP = DecompositionResult(
    is_course_correction=False,
    overall_reasoning_complexity="fast",
    short_term_memory={"sentiment": "positive", "concern": ""},
    long_term_memory=[
        {
            "subject_type": "person", "subject_name": "Luke",
            "predicate": "loves", "value": "movies", "kind": "fact",
            "category": "preference", "negates_previous": False,
        },
    ],
    asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="acknowledge")],
    model="gemma4:e2b", latency_ms=100.0,
)


def _make_recording_stream(text: str, sink: dict):
    """Stream that also records the kwargs it was called with."""
    async def _gen(*_a, **kw):
        sink.update(kw)
        for c in [text[i:i + 4] for i in range(0, len(text), 4)] or [""]:
            yield c
    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "ack.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture
async def user_session(memory):
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    return uid, sid


@pytest.mark.anyio
async def test_orchestrator_uses_ack_prompt_for_fact_turn(memory, user_session):
    """Pin the routing: fact-sharing turn → ack prompt + tight cap."""
    uid, sid = user_session
    decomp = AsyncMock()
    decomp.decompose = AsyncMock(return_value=PERSON_FACT_DECOMP)
    inf = AsyncMock()
    inf.generate = AsyncMock(return_value="title")
    captured: dict = {}
    inf.generate_stream = _make_recording_stream("Got it — noted.", captured)

    orch = Orchestrator(
        decomposer=decomp,
        inference_client=inf,
        memory=memory,
        model_manager=ModelManager(inference_client=inf, policy=ModelPolicy(platform="mac")),
    )

    async for _ in orch.process(
        "my brother luke loves movies", user_id=uid, session_id=sid
    ):
        pass

    assert "prompt" in captured, "generate_stream was never called"
    # Landmark strings of the new ack template.
    assert "YOUR PERSONALITY" in captured["prompt"]
    assert "warm, friendly conversational assistant" in captured["prompt"]
    assert "Now respond" in captured["prompt"]
    # The general synthesis template should NOT be in the prompt.
    # ``RECENT_TURNS:`` is uniquely the general template's landmark
    # (the ack template uses few-shot examples instead).
    assert "RECENT_TURNS:" not in captured["prompt"]
    # And the cap is the ack one.
    assert captured["num_predict"] == ACKNOWLEDGMENT_NUM_PREDICT
    # CRITICAL: the user's input must not be duplicated in the few-shot.
    fewshot = captured["prompt"].split("Now respond")[0]
    assert "my brother luke loves movies" not in fewshot


@pytest.mark.anyio
async def test_orchestrator_uses_general_prompt_for_question(memory, user_session):
    """Pin the inverse: a question with no extracted facts → general prompt."""
    uid, sid = user_session
    question_decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        short_term_memory={"sentiment": "neutral", "concern": ""},
        long_term_memory=[],  # no facts
        asks=[Ask(ask_id="ask_001", intent="direct_chat",
                  distilled_query="what's 2+2?")],
        model="gemma4:e2b", latency_ms=80.0,
    )
    decomp = AsyncMock()
    decomp.decompose = AsyncMock(return_value=question_decomp)
    inf = AsyncMock()
    inf.generate = AsyncMock(return_value="title")
    captured: dict = {}
    inf.generate_stream = _make_recording_stream("4.", captured)

    orch = Orchestrator(
        decomposer=decomp,
        inference_client=inf,
        memory=memory,
        model_manager=ModelManager(inference_client=inf, policy=ModelPolicy(platform="mac")),
    )

    async for _ in orch.process("what's 2+2?", user_id=uid, session_id=sid):
        pass

    # Landmarks of the new general (memory-aware) synthesis template.
    assert "RECENT_TURNS:" in captured["prompt"]
    assert "USER_QUERY:" in captured["prompt"]
    assert "GOOD EXAMPLES" not in captured["prompt"]
    assert captured["num_predict"] == SYNTHESIS_NUM_PREDICT


@pytest.mark.anyio
async def test_ack_token_cap_is_smaller_than_synthesis_cap():
    """Sanity: the ack cap must be tighter than the general cap, but loose
    enough to fit a warm 1–2 sentence response with a follow-up question."""
    assert ACKNOWLEDGMENT_NUM_PREDICT < SYNTHESIS_NUM_PREDICT
    # 80–120 token range — fits a friend-style reaction without monologuing.
    assert 60 <= ACKNOWLEDGMENT_NUM_PREDICT <= 150
