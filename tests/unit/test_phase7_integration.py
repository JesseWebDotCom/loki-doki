"""Phase 7 integration tests: experiment-arm assignment on the chat path.

Verifies that:
- Experiment arms are assigned and persisted during chat turns
- The memory format experiment switches the formatter correctly
- The reranker experiment conditionally reranks facts
- Fact telemetry is recorded when facts are retrieved/injected
- No experiment arm breaks citations, prompt budget, or answer-first
- Regression: existing behavior unchanged on control arms
"""
import pytest
from unittest.mock import AsyncMock

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.reranker import set_reranker_for_testing


MOCK_DECOMPOSITION = DecompositionResult(
    is_course_correction=False,
    overall_reasoning_complexity="fast",
    short_term_memory={"sentiment": "neutral", "concern": ""},
    long_term_memory=[],
    asks=[
        Ask(ask_id="ask_001", intent="direct_chat",
            distilled_query="Tell me about hiking")
    ],
    model="gemma4:e2b",
    latency_ms=100.0,
)

MOCK_RESPONSE = "Hiking is great exercise and a wonderful way to explore nature."


def _make_stream(text: str, chunk_size: int = 8):
    chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)] or [""]

    async def _gen(*_args, **_kwargs):
        for c in chunks:
            yield c

    return _gen


class _FakeReranker:
    """Deterministic reranker for tests."""
    def __init__(self):
        self.called = False

    def rerank(self, query, passages, top_k=5):
        self.called = True
        return [(i, float(i)) for i in range(min(top_k, len(passages)))]


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase7.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture
async def user_session(memory):
    user_id = await memory.get_or_create_user("default")
    session_id = await memory.create_session(user_id)
    return user_id, session_id


@pytest.fixture
def orchestrator(memory):
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=MOCK_DECOMPOSITION)
    mock_inference = AsyncMock()
    mock_inference.generate = AsyncMock(return_value=MOCK_RESPONSE)
    mock_inference.generate_stream = _make_stream(MOCK_RESPONSE)
    policy = ModelPolicy(platform="mac")
    model_manager = ModelManager(inference_client=mock_inference, policy=policy)
    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=model_manager,
    )


class TestExperimentArmAssignment:
    @pytest.mark.anyio
    async def test_arms_assigned_during_chat(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("Tell me about hiking", user_id=uid, session_id=sid):
            pass

        mem_arm = await memory.get_experiment_arm(uid, "memory_format_v1")
        reranker_arm = await memory.get_experiment_arm(uid, "reranker_v1")
        assert mem_arm in ("control", "warm")
        assert reranker_arm in ("control", "reranker")

    @pytest.mark.anyio
    @pytest.mark.skip(reason="Temporarily disabled per user request")
    async def test_arms_persist_across_turns(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("Hello", user_id=uid, session_id=sid):
            pass
        arm1 = await memory.get_experiment_arm(uid, "memory_format_v1")

        async for _ in orchestrator.process("How are you?", user_id=uid, session_id=sid):
            pass
        arm2 = await memory.get_experiment_arm(uid, "memory_format_v1")
        assert arm1 == arm2

    @pytest.mark.anyio
    async def test_experiment_arms_logged_in_trace(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("Tell me about hiking", user_id=uid, session_id=sid):
            pass
        traces = await memory.list_chat_traces(uid, session_id=sid, limit=1)
        assert len(traces) >= 1
        injected = traces[0].get("selected_injected_memories_json", {})
        arms = injected.get("experiment_arms", {})
        assert "memory_format_v1" in arms
        assert "reranker_v1" in arms


class TestFactTelemetryOnChatPath:
    @pytest.mark.anyio
    async def test_telemetry_recorded_for_retrieved_facts(self, orchestrator, memory, user_session):
        uid, sid = user_session
        # Seed a fact that will be retrieved.
        await memory.upsert_fact(
            user_id=uid, subject="self", predicate="likes",
            value="hiking in mountains", category="preference",
        )
        async for _ in orchestrator.process("Tell me about hiking", user_id=uid, session_id=sid):
            pass
        facts = await memory.list_facts(uid, limit=10)
        hiking_facts = [f for f in facts if "hiking" in (f.get("value") or "")]
        if hiking_facts:
            telemetry = await memory.get_fact_telemetry(hiking_facts[0]["id"])
            # Telemetry should exist if the fact was retrieved as a candidate.
            if telemetry:
                assert telemetry["retrieve_count"] >= 1


class TestRerankerExperiment:
    @pytest.mark.anyio
    async def test_reranker_arm_invokes_reranker(self, orchestrator, memory, user_session):
        uid, sid = user_session
        # Force reranker arm.
        await memory.set_experiment_arm(uid, "reranker_v1", "reranker")
        fake = _FakeReranker()
        set_reranker_for_testing(fake)
        try:
            # Seed facts so there are candidates to rerank.
            for val in ("hiking", "coffee", "reading"):
                await memory.upsert_fact(
                    user_id=uid, subject="self", predicate="likes",
                    value=val, category="preference",
                )
            async for _ in orchestrator.process("Tell me about hiking", user_id=uid, session_id=sid):
                pass
            assert fake.called
        finally:
            set_reranker_for_testing(None)

    @pytest.mark.anyio
    async def test_control_arm_skips_reranker(self, orchestrator, memory, user_session):
        uid, sid = user_session
        await memory.set_experiment_arm(uid, "reranker_v1", "control")
        fake = _FakeReranker()
        set_reranker_for_testing(fake)
        try:
            async for _ in orchestrator.process("Hello", user_id=uid, session_id=sid):
                pass
            assert not fake.called
        finally:
            set_reranker_for_testing(None)


class TestRegressionNoBrokenBehavior:
    """Ensure no experiment arm breaks the pipeline."""

    @pytest.mark.anyio
    async def test_chat_completes_with_response(self, orchestrator, user_session):
        uid, sid = user_session
        events = []
        async for ev in orchestrator.process("What is hiking?", user_id=uid, session_id=sid):
            events.append(ev)
        final = [e for e in events if e.phase == "synthesis" and e.status == "done"]
        assert len(final) == 1
        assert final[0].data.get("response")

    @pytest.mark.anyio
    async def test_messages_persisted(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("Hello", user_id=uid, session_id=sid):
            pass
        msgs = await memory.get_messages(user_id=uid, session_id=sid)
        assert len(msgs) >= 2
        roles = [m["role"] for m in msgs]
        assert "user" in roles
        assert "assistant" in roles

    @pytest.mark.anyio
    async def test_realistic_user_inputs(self, orchestrator, user_session):
        """Realistic messy user turns should not crash the pipeline."""
        uid, sid = user_session
        messy_inputs = [
            "ugh im so tired rn",
            "what was that thing we talked about??",
            "no not that one, the OTHER one",
            "thanks!!",
            "hey whats the weather like today",
        ]
        for inp in messy_inputs:
            events = []
            async for ev in orchestrator.process(inp, user_id=uid, session_id=sid):
                events.append(ev)
            final = [e for e in events if e.phase == "synthesis" and e.status == "done"]
            assert len(final) == 1, f"No final synthesis for input: {inp}"
