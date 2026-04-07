import asyncio
import pytest
import json
from unittest.mock import AsyncMock, patch
from lokidoki.core.decomposer import Decomposer, DecompositionResult, Ask
from lokidoki.core.inference import OllamaError


VALID_LLM_RESPONSE = json.dumps({
    "is_course_correction": False,
    "overall_reasoning_complexity": "fast",
    "short_term_memory": {
        "sentiment": "curious",
        "concern": "weather for outdoor plans"
    },
    "long_term_memory": [
        {
            "subject_type": "self",
            "subject_name": "",
            "predicate": "enjoys",
            "value": "hiking",
            "kind": "fact",
            "category": "preference",
        }
    ],
    "asks": [
        {
            "ask_id": "ask_001",
            "intent": "weather_owm.get_forecast",
            "distilled_query": "What is the weather today?",
            "parameters": {"location": "current_location"}
        }
    ]
})

MULTI_ASK_RESPONSE = json.dumps({
    "is_course_correction": False,
    "overall_reasoning_complexity": "thinking",
    "short_term_memory": {"sentiment": "excited", "concern": "planning weekend"},
    "long_term_memory": [],
    "asks": [
        {
            "ask_id": "ask_001",
            "intent": "weather_owm.get_forecast",
            "distilled_query": "Weekend weather forecast",
            "parameters": {"location": "current_location"}
        },
        {
            "ask_id": "ask_002",
            "intent": "knowledge_wiki.search",
            "distilled_query": "Best hiking trails nearby",
            "parameters": {"query": "hiking trails"}
        }
    ]
})

COURSE_CORRECTION_RESPONSE = json.dumps({
    "is_course_correction": True,
    "overall_reasoning_complexity": "fast",
    "short_term_memory": {"sentiment": "frustrated", "concern": "wrong answer"},
    "long_term_memory": [],
    "asks": []
})


@pytest.fixture
def decomposer():
    mock_client = AsyncMock()
    return Decomposer(inference_client=mock_client, model="gemma4:e2b")


class TestDecomposer:
    @pytest.mark.anyio
    async def test_decompose_single_ask(self, decomposer):
        """Test decomposition of a simple single-intent query."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        result = await decomposer.decompose("What's the weather today?")

        assert isinstance(result, DecompositionResult)
        assert result.is_course_correction is False
        assert result.overall_reasoning_complexity == "fast"
        assert len(result.asks) == 1
        assert result.asks[0].intent == "weather_owm.get_forecast"
        assert result.asks[0].distilled_query == "What is the weather today?"

    @pytest.mark.anyio
    async def test_decompose_multi_ask(self, decomposer):
        """Test decomposition into multiple parallel asks."""
        decomposer._client.generate = AsyncMock(return_value=MULTI_ASK_RESPONSE)

        result = await decomposer.decompose("What's the weather this weekend and where can I hike?")

        assert len(result.asks) == 2
        assert result.overall_reasoning_complexity == "thinking"
        assert result.asks[0].ask_id == "ask_001"
        assert result.asks[1].ask_id == "ask_002"

    @pytest.mark.anyio
    async def test_decompose_course_correction(self, decomposer):
        """Test detection of course correction (meta-commentary)."""
        decomposer._client.generate = AsyncMock(return_value=COURSE_CORRECTION_RESPONSE)

        result = await decomposer.decompose("No, I meant the other thing")

        assert result.is_course_correction is True
        assert len(result.asks) == 0

    @pytest.mark.anyio
    async def test_decompose_extracts_sentiment(self, decomposer):
        """Test that short-term sentiment is extracted."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        result = await decomposer.decompose("Will it rain?")

        assert result.short_term_memory["sentiment"] == "curious"
        assert result.short_term_memory["concern"] == "weather for outdoor plans"

    @pytest.mark.anyio
    async def test_decompose_extracts_long_term_facts(self, decomposer):
        """PR3: long-term memory items are structured (subject/predicate/value)."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        result = await decomposer.decompose("I love hiking")

        assert len(result.long_term_memory) == 1
        item = result.long_term_memory[0]
        assert item["subject_type"] == "self"
        assert item["predicate"] == "enjoys"
        assert item["value"] == "hiking"
        assert item["kind"] == "fact"

    @pytest.mark.anyio
    async def test_decompose_uses_schema_constrained_output(self, decomposer):
        """Regression: the decomposer must request schema-constrained generation
        (format_schema), not freeform JSON mode. Schema-constrained decoding
        terminates as soon as the schema is satisfied, which fixes the
        gemma+JSON-mode trailing-whitespace runaway at the source.
        See incident 2026-04-06."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        await decomposer.decompose("test")

        decomposer._client.generate.assert_called_once()
        kwargs = decomposer._client.generate.call_args.kwargs
        schema = kwargs.get("format_schema")
        assert isinstance(schema, dict), "decomposer must pass a JSON schema, not json_mode"
        assert schema.get("type") == "object"
        # Enum on reasoning_complexity prevents the model from stuffing the
        # wrong value into the field (observed bug: "direct_chat" leaking in).
        rc = schema["properties"]["overall_reasoning_complexity"]
        assert rc.get("enum") == ["fast", "thinking"]
        # Deterministic decoding for parsing.
        assert kwargs.get("temperature") == 0.0

    @pytest.mark.anyio
    async def test_decompose_passes_num_predict_cap(self, decomposer):
        """Regression: gemma4:e2b in JSON mode degenerates into trailing whitespace
        until it hits num_predict. The decomposer MUST cap output tokens to prevent
        a single request from running for >100s. See incident 2026-04-06."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        await decomposer.decompose("test")

        kwargs = decomposer._client.generate.call_args.kwargs
        assert "num_predict" in kwargs, "decomposer must pass num_predict to bound generation"
        assert kwargs["num_predict"] > 0
        assert kwargs["num_predict"] <= 1024, "num_predict cap should keep latency bounded"

    @pytest.mark.anyio
    async def test_decompose_times_out_to_fallback(self):
        """Regression: if the inference call hangs, decompose() must time out and
        return a direct_chat fallback rather than blocking the pipeline forever."""
        mock_client = AsyncMock()

        async def hang(*_a, **_kw):
            await asyncio.sleep(10)
            return VALID_LLM_RESPONSE

        mock_client.generate = AsyncMock(side_effect=hang)
        d = Decomposer(inference_client=mock_client, model="gemma4:e2b", timeout_s=0.05)

        result = await d.decompose("anything")

        assert isinstance(result, DecompositionResult)
        assert len(result.asks) == 1
        assert result.asks[0].intent == "direct_chat"
        assert result.asks[0].distilled_query == "anything"

    @pytest.mark.anyio
    async def test_decompose_handles_ollama_error(self, decomposer):
        """If Ollama errors out, decomposer should fall back, not raise."""
        decomposer._client.generate = AsyncMock(side_effect=OllamaError("model missing"))

        result = await decomposer.decompose("hello")

        assert len(result.asks) == 1
        assert result.asks[0].intent == "direct_chat"

    @pytest.mark.anyio
    async def test_decompose_handles_malformed_json(self, decomposer):
        """Test graceful handling when LLM returns invalid JSON."""
        decomposer._client.generate = AsyncMock(return_value="not valid json {{{")

        result = await decomposer.decompose("test input")

        # Should return a fallback result with the raw input as a single ask
        assert isinstance(result, DecompositionResult)
        assert len(result.asks) == 1
        assert result.asks[0].intent == "direct_chat"
        assert result.asks[0].distilled_query == "test input"

    @pytest.mark.anyio
    async def test_decompose_handles_partial_json(self, decomposer):
        """Test handling when LLM returns JSON missing required fields."""
        partial = json.dumps({"is_course_correction": False, "asks": []})
        decomposer._client.generate = AsyncMock(return_value=partial)

        result = await decomposer.decompose("test")

        assert isinstance(result, DecompositionResult)
        assert result.overall_reasoning_complexity == "fast"  # default fallback

    @pytest.mark.anyio
    async def test_build_prompt_includes_user_input(self, decomposer):
        """Test that the prompt sent to the LLM contains the user input."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        await decomposer.decompose("What time is it in Tokyo?")

        call_args = decomposer._client.generate.call_args
        prompt = call_args.kwargs.get("prompt") or call_args[0][1]
        assert "What time is it in Tokyo?" in prompt

    @pytest.mark.anyio
    async def test_build_prompt_includes_context(self, decomposer):
        """Test that chat context is injected into the prompt."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        context = [
            {"role": "user", "content": "I live in Seattle"},
            {"role": "assistant", "content": "Got it, Seattle!"},
        ]
        await decomposer.decompose("What's the weather?", chat_context=context)

        call_args = decomposer._client.generate.call_args
        prompt = call_args.kwargs.get("prompt") or call_args[0][1]
        assert "Seattle" in prompt

    @pytest.mark.anyio
    async def test_build_prompt_includes_skill_intents(self, decomposer):
        """Test that available skill intents are listed in the prompt."""
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        intents = ["weather_owm.get_forecast", "knowledge_wiki.search"]
        await decomposer.decompose("test", available_intents=intents)

        call_args = decomposer._client.generate.call_args
        prompt = call_args.kwargs.get("prompt") or call_args[0][1]
        assert "weather_owm.get_forecast" in prompt
        assert "knowledge_wiki.search" in prompt


class TestAskDataclass:
    def test_ask_creation(self):
        ask = Ask(
            ask_id="ask_001",
            intent="weather_owm.get_forecast",
            distilled_query="Weather today?",
            parameters={"location": "home"}
        )
        assert ask.ask_id == "ask_001"
        assert ask.parameters["location"] == "home"

    def test_ask_default_parameters(self):
        ask = Ask(ask_id="ask_001", intent="direct_chat", distilled_query="hello")
        assert ask.parameters == {}
