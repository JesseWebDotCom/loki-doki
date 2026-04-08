"""Orchestrator tests — PR1 rewrite using MemoryProvider.

Per-test we get a fresh provider backed by a tmp file. The orchestrator
is required to persist user + assistant messages and any decomposer-
extracted facts via the provider; this file pins that contract.
"""
import pytest
from unittest.mock import AsyncMock

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator, PipelineEvent


MOCK_DECOMPOSITION = DecompositionResult(
    is_course_correction=False,
    overall_reasoning_complexity="fast",
    short_term_memory={"sentiment": "curious", "concern": "weather"},
    long_term_memory=[{
        "subject_type": "self", "subject_name": "",
        "predicate": "likes", "value": "Likes hiking",
        "kind": "fact", "category": "preference",
    }],
    asks=[
        Ask(ask_id="ask_001", intent="weather_owm.get_forecast",
            distilled_query="Weather today?", parameters={"location": "home"})
    ],
    model="gemma4:e2b",
    latency_ms=150.0,
)

MOCK_SYNTHESIS_RESPONSE = "It looks like a sunny day today! Perfect for hiking."


def _make_stream(text: str, chunk_size: int = 8):
    chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)] or [""]

    async def _gen(*_args, **_kwargs):
        for c in chunks:
            yield c

    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "orch.db"))
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
    mock_inference.generate = AsyncMock(return_value=MOCK_SYNTHESIS_RESPONSE)
    mock_inference.generate_stream = _make_stream(MOCK_SYNTHESIS_RESPONSE)

    policy = ModelPolicy(platform="mac")
    model_manager = ModelManager(inference_client=mock_inference, policy=policy)

    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=model_manager,
    )


class TestOrchestrator:
    @pytest.mark.anyio
    async def test_process_emits_phase_events(self, orchestrator, user_session):
        uid, sid = user_session
        events = []
        async for event in orchestrator.process("What's the weather?", user_id=uid, session_id=sid):
            events.append(event)

        phases = [e.phase for e in events]
        assert "augmentation" in phases
        assert "decomposition" in phases
        assert "synthesis" in phases

    @pytest.mark.anyio
    async def test_process_returns_final_response(self, orchestrator, user_session):
        uid, sid = user_session
        events = []
        async for event in orchestrator.process("What's the weather?", user_id=uid, session_id=sid):
            events.append(event)

        final = [e for e in events if e.phase == "synthesis" and e.status == "done"]
        assert len(final) == 1
        assert MOCK_SYNTHESIS_RESPONSE in final[0].data.get("response", "")

    @pytest.mark.anyio
    async def test_process_persists_messages(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("Hello", user_id=uid, session_id=sid):
            pass

        msgs = await memory.get_messages(user_id=uid, session_id=sid)
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"

    @pytest.mark.anyio
    async def test_process_persists_extracted_facts(self, orchestrator, memory, user_session):
        uid, sid = user_session
        async for _ in orchestrator.process("I like hiking", user_id=uid, session_id=sid):
            pass
        facts = await memory.list_facts(uid)
        assert any(f["value"] == "Likes hiking" for f in facts)

    @pytest.mark.anyio
    async def test_decomposition_event_contains_asks(self, orchestrator, user_session):
        uid, sid = user_session
        events = []
        async for event in orchestrator.process("Weather?", user_id=uid, session_id=sid):
            events.append(event)

        decomp_done = [e for e in events if e.phase == "decomposition" and e.status == "done"]
        assert len(decomp_done) == 1
        asks = decomp_done[0].data.get("asks", [])
        assert len(asks) == 1
        assert asks[0]["intent"] == "weather_owm.get_forecast"

    @pytest.mark.anyio
    async def test_course_correction_skips_skills(self, orchestrator, user_session):
        uid, sid = user_session
        correction = DecompositionResult(
            is_course_correction=True,
            overall_reasoning_complexity="fast",
            asks=[],
            model="gemma4:e2b",
            latency_ms=50.0,
        )
        orchestrator._decomposer.decompose = AsyncMock(return_value=correction)

        events = []
        async for event in orchestrator.process("No I meant the other thing", user_id=uid, session_id=sid):
            events.append(event)

        phases = [e.phase for e in events]
        assert "routing" not in phases

    @pytest.mark.anyio
    async def test_synthesis_uses_thinking_model_for_long_complex_queries(
        self, orchestrator, user_session
    ):
        uid, sid = user_session
        thinking_result = DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="thinking",
            asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="Explain quantum physics")],
            model="gemma4:e2b",
            latency_ms=200.0,
        )
        orchestrator._decomposer.decompose = AsyncMock(return_value=thinking_result)
        captured: dict = {}

        def stream_factory(*_a, **kw):
            captured.update(kw)

            async def _gen():
                yield "ok"

            return _gen()

        orchestrator._inference.generate_stream = stream_factory

        long_query = (
            "Explain quantum physics in detail and walk me through the full "
            "multi-step derivation of the Heisenberg uncertainty principle please."
        )
        async for _ in orchestrator.process(long_query, user_id=uid, session_id=sid):
            pass

        assert captured.get("model") == "gemma4"  # mac uses 9B for thinking
        assert captured.get("keep_alive") == "5m"

    @pytest.mark.anyio
    async def test_admin_prompt_injected_into_synthesis(self, memory, user_session):
        uid, sid = user_session
        mock_decomposer = AsyncMock()
        mock_decomposer.decompose = AsyncMock(return_value=MOCK_DECOMPOSITION)
        mock_inference = AsyncMock()
        captured: dict = {}

        def stream_factory(*_a, **kw):
            captured.update(kw)

            async def _gen():
                yield "Safe response"

            return _gen()

        mock_inference.generate_stream = stream_factory

        orch = Orchestrator(
            decomposer=mock_decomposer,
            inference_client=mock_inference,
            memory=memory,
            admin_prompt="NO PROFANITY",
            user_prompt="Be funny",
        )

        async for _ in orch.process("Tell me a joke", user_id=uid, session_id=sid):
            pass

        prompt = captured["prompt"]
        assert "ADMIN_RULES:NO PROFANITY" in prompt
        # USER_STYLE was renamed to PERSONA when the character system was
        # folded into the synthesis prompt — same slot, clearer label.
        assert "PERSONA:Be funny" in prompt
        assert "PRIORITY:Admin>Project>Persona>Memory" in prompt

    @pytest.mark.anyio
    async def test_synthesis_emits_streaming_deltas(self, orchestrator, user_session):
        uid, sid = user_session
        events = []
        async for event in orchestrator.process("hi", user_id=uid, session_id=sid):
            events.append(event)

        deltas = [e for e in events if e.phase == "synthesis" and e.status == "streaming"]
        assert len(deltas) >= 2
        assembled = "".join(e.data["delta"] for e in deltas)
        assert assembled == MOCK_SYNTHESIS_RESPONSE
        done = next(e for e in events if e.phase == "synthesis" and e.status == "done")
        assert events.index(done) > events.index(deltas[-1])
        assert done.data["response"] == MOCK_SYNTHESIS_RESPONSE

    @pytest.mark.anyio
    async def test_synthesis_caps_num_predict_and_sets_temperature(
        self, orchestrator, user_session
    ):
        uid, sid = user_session
        captured: dict = {}

        def stream_factory(*_a, **kw):
            captured.update(kw)

            async def _gen():
                yield MOCK_SYNTHESIS_RESPONSE

            return _gen()

        orchestrator._inference.generate_stream = stream_factory

        async for _ in orchestrator.process("hi", user_id=uid, session_id=sid):
            pass

        assert 0 < captured["num_predict"] <= 1024
        assert 0 <= captured["temperature"] < 1

    @pytest.mark.anyio
    async def test_short_query_forces_fast_model_even_when_thinking(
        self, orchestrator, user_session
    ):
        """Regression: trivial questions stay on the fast model even if the
        decomposer over-classifies as 'thinking'."""
        uid, sid = user_session
        thinking_short = DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="thinking",
            asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="Is danny mcbride still acting?")],
            model="gemma4:e2b",
            latency_ms=100.0,
        )
        orchestrator._decomposer.decompose = AsyncMock(return_value=thinking_short)
        captured: dict = {}

        def stream_factory(*_a, **kw):
            captured.update(kw)

            async def _gen():
                yield "Yes."

            return _gen()

        orchestrator._inference.generate_stream = stream_factory

        async for _ in orchestrator.process("Is danny mcbride still acting?", user_id=uid, session_id=sid):
            pass

        assert captured["model"] == "gemma4:e2b"


class TestPR3PersonResolution:
    """End-to-end exit-criterion check from MEMORY_ROADMAP.md."""

    @pytest.mark.anyio
    async def test_brother_mark_creates_one_person_one_rel_two_facts(
        self, memory, user_session
    ):
        from lokidoki.core import memory_people_ops  # noqa: F401  bind methods

        uid, sid = user_session

        decomp = DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="fast",
            short_term_memory={"sentiment": "neutral", "concern": ""},
            long_term_memory=[
                {
                    "subject_type": "person", "subject_name": "Mark",
                    "predicate": "is", "value": "brother",
                    "kind": "relationship", "relationship_kind": "brother",
                },
                {
                    "subject_type": "person", "subject_name": "Mark",
                    "predicate": "location", "value": "Denver", "kind": "fact",
                },
                {
                    "subject_type": "person", "subject_name": "Mark",
                    "predicate": "occupation", "value": "plumber", "kind": "fact",
                },
            ],
            asks=[Ask(ask_id="ask_001", intent="direct_chat",
                       distilled_query="my brother Mark lives in Denver and works as a plumber")],
            model="gemma4:e2b",
            latency_ms=10.0,
        )

        mock_decomposer = AsyncMock()
        mock_decomposer.decompose = AsyncMock(return_value=decomp)
        mock_inference = AsyncMock()
        mock_inference.generate_stream = _make_stream("ok")
        policy = ModelPolicy(platform="mac")
        orch = Orchestrator(
            decomposer=mock_decomposer,
            inference_client=mock_inference,
            memory=memory,
            model_manager=ModelManager(inference_client=mock_inference, policy=policy),
        )

        async for _ in orch.process(
            "my brother Mark lives in Denver and works as a plumber",
            user_id=uid, session_id=sid,
        ):
            pass

        people = await memory.list_people(uid)
        assert len(people) == 1 and people[0]["name"] == "Mark"
        rels = await memory.list_relationships(uid)
        assert len(rels) == 1 and rels[0]["relation"] == "brother"
        person_facts = await memory.list_facts_about_person(uid, people[0]["id"])
        # The relationship item also writes a fact row (predicate=is, value=brother),
        # plus location and occupation. Three rows total on the person.
        values = sorted(f["value"] for f in person_facts)
        assert values == ["Denver", "brother", "plumber"]


class TestPipelineEvent:
    def test_event_serialization(self):
        event = PipelineEvent(
            phase="decomposition", status="done",
            data={"model": "gemma4:e2b", "latency_ms": 150.0},
        )
        d = event.to_dict()
        assert d["phase"] == "decomposition"
        assert d["data"]["model"] == "gemma4:e2b"

    def test_event_to_sse(self):
        event = PipelineEvent(phase="augmentation", status="active", data={})
        sse = event.to_sse()
        assert sse.startswith("data: ")
        assert "augmentation" in sse
