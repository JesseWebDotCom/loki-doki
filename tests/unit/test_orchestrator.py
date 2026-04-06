import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch
from lokidoki.core.orchestrator import Orchestrator, PipelineEvent
from lokidoki.core.decomposer import DecompositionResult, Ask
from lokidoki.core.memory import SessionMemory
from lokidoki.core.model_manager import ModelManager, ModelPolicy


MOCK_DECOMPOSITION = DecompositionResult(
    is_course_correction=False,
    overall_reasoning_complexity="fast",
    short_term_memory={"sentiment": "curious", "concern": "weather"},
    long_term_memory=[{"category": "preference", "fact": "Likes hiking"}],
    asks=[
        Ask(ask_id="ask_001", intent="weather_owm.get_forecast",
            distilled_query="Weather today?", parameters={"location": "home"})
    ],
    model="gemma4:e2b",
    latency_ms=150.0,
)

MOCK_SYNTHESIS_RESPONSE = "It looks like a sunny day today! Perfect for hiking."


@pytest.fixture
def orchestrator():
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=MOCK_DECOMPOSITION)

    mock_inference = AsyncMock()
    mock_inference.generate = AsyncMock(return_value=MOCK_SYNTHESIS_RESPONSE)

    memory = SessionMemory()
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
    async def test_process_emits_phase_events(self, orchestrator):
        events = []
        async for event in orchestrator.process("What's the weather?"):
            events.append(event)

        phase_types = [e.phase for e in events]
        assert "augmentation" in phase_types
        assert "decomposition" in phase_types
        assert "synthesis" in phase_types

    @pytest.mark.anyio
    async def test_process_returns_final_response(self, orchestrator):
        events = []
        async for event in orchestrator.process("What's the weather?"):
            events.append(event)

        final = [e for e in events if e.phase == "synthesis" and e.status == "done"]
        assert len(final) == 1
        assert MOCK_SYNTHESIS_RESPONSE in final[0].data.get("response", "")

    @pytest.mark.anyio
    async def test_process_stores_messages_in_memory(self, orchestrator):
        async for _ in orchestrator.process("Hello"):
            pass

        assert len(orchestrator._memory.messages) == 2
        assert orchestrator._memory.messages[0]["role"] == "user"
        assert orchestrator._memory.messages[1]["role"] == "assistant"

    @pytest.mark.anyio
    async def test_process_ingests_sentiment_and_facts(self, orchestrator):
        async for _ in orchestrator.process("I like hiking in the rain"):
            pass

        assert orchestrator._memory.sentiment["sentiment"] == "curious"
        assert len(orchestrator._memory.facts) == 1

    @pytest.mark.anyio
    async def test_decomposition_event_contains_asks(self, orchestrator):
        events = []
        async for event in orchestrator.process("Weather?"):
            events.append(event)

        decomp_done = [e for e in events if e.phase == "decomposition" and e.status == "done"]
        assert len(decomp_done) == 1
        asks = decomp_done[0].data.get("asks", [])
        assert len(asks) == 1
        assert asks[0]["intent"] == "weather_owm.get_forecast"

    @pytest.mark.anyio
    async def test_decomposition_event_contains_model_info(self, orchestrator):
        events = []
        async for event in orchestrator.process("test"):
            events.append(event)

        decomp_done = [e for e in events if e.phase == "decomposition" and e.status == "done"]
        assert decomp_done[0].data["model"] == "gemma4:e2b"
        assert decomp_done[0].data["latency_ms"] == 150.0

    @pytest.mark.anyio
    async def test_course_correction_skips_skills(self, orchestrator):
        correction = DecompositionResult(
            is_course_correction=True,
            overall_reasoning_complexity="fast",
            asks=[],
            model="gemma4:e2b",
            latency_ms=50.0,
        )
        orchestrator._decomposer.decompose = AsyncMock(return_value=correction)

        events = []
        async for event in orchestrator.process("No I meant the other thing"):
            events.append(event)

        phases = [e.phase for e in events]
        assert "routing" not in phases

    @pytest.mark.anyio
    async def test_synthesis_uses_thinking_model_for_complex_queries(self, orchestrator):
        """Test that 'thinking' complexity triggers the 9B model on capable platforms."""
        thinking_result = DecompositionResult(
            is_course_correction=False,
            overall_reasoning_complexity="thinking",
            asks=[Ask(ask_id="ask_001", intent="direct_chat", distilled_query="Explain quantum physics")],
            model="gemma4:e2b",
            latency_ms=200.0,
        )
        orchestrator._decomposer.decompose = AsyncMock(return_value=thinking_result)

        async for _ in orchestrator.process("Explain quantum physics"):
            pass

        call_kwargs = orchestrator._inference.generate.call_args.kwargs
        assert call_kwargs.get("model") == "gemma4"  # Mac uses 9B for thinking
        assert call_kwargs.get("keep_alive") == "5m"

    @pytest.mark.anyio
    async def test_synthesis_includes_platform_info(self, orchestrator):
        events = []
        async for event in orchestrator.process("Hello"):
            events.append(event)

        synth_done = [e for e in events if e.phase == "synthesis" and e.status == "done"]
        assert synth_done[0].data["platform"] == "mac"

    @pytest.mark.anyio
    async def test_admin_prompt_injected_into_synthesis(self):
        mock_decomposer = AsyncMock()
        mock_decomposer.decompose = AsyncMock(return_value=MOCK_DECOMPOSITION)
        mock_inference = AsyncMock()
        mock_inference.generate = AsyncMock(return_value="Safe response")

        orch = Orchestrator(
            decomposer=mock_decomposer,
            inference_client=mock_inference,
            memory=SessionMemory(),
            admin_prompt="NO PROFANITY",
            user_prompt="Be funny",
        )

        async for _ in orch.process("Tell me a joke"):
            pass

        prompt = mock_inference.generate.call_args.kwargs["prompt"]
        assert "ADMIN_RULES:NO PROFANITY" in prompt
        assert "USER_STYLE:Be funny" in prompt
        assert "PRIORITY:Admin>User>Persona" in prompt


class TestPipelineEvent:
    def test_event_serialization(self):
        event = PipelineEvent(
            phase="decomposition",
            status="done",
            data={"model": "gemma4:e2b", "latency_ms": 150.0}
        )
        d = event.to_dict()
        assert d["phase"] == "decomposition"
        assert d["status"] == "done"
        assert d["data"]["model"] == "gemma4:e2b"

    def test_event_to_sse(self):
        event = PipelineEvent(phase="augmentation", status="active", data={})
        sse = event.to_sse()
        assert sse.startswith("data: ")
        assert "augmentation" in sse
