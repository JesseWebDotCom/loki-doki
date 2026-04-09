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
            "parameters": {"location": "current_location"},
            "context_source": "external",
            "referent_type": "event",
            "durability": "ephemeral",
            "needs_referent_resolution": False,
            "capability_need": "web_search",
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
            "parameters": {"location": "current_location"},
            "context_source": "external",
            "referent_type": "event",
            "durability": "ephemeral",
            "needs_referent_resolution": False,
            "capability_need": "web_search",
        },
        {
            "ask_id": "ask_002",
            "intent": "knowledge_wiki.search",
            "distilled_query": "Best hiking trails nearby",
            "parameters": {"query": "hiking trails"},
            "context_source": "external",
            "referent_type": "entity",
            "durability": "ephemeral",
            "needs_referent_resolution": False,
            "capability_need": "encyclopedic",
        }
    ]
})

STRUCTURED_ROUTING_RESPONSE = json.dumps({
    "is_course_correction": False,
    "overall_reasoning_complexity": "fast",
    "short_term_memory": {"sentiment": "neutral", "concern": "none"},
    "long_term_memory": [],
    "asks": [
        {
            "ask_id": "ask_001",
            "intent": "direct_chat",
            "distilled_query": "What is the full name of the movie?",
            "parameters": {},
            "response_shape": "synthesized",
            "requires_current_data": False,
            "knowledge_source": "none",
            "context_source": "recent_context",
            "referent_type": "media",
            "durability": "ephemeral",
            "needs_referent_resolution": True,
            "capability_need": "none",
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
    async def test_known_subjects_renders_into_prompt(self, decomposer):
        """The closed-world subject registry must reach the LLM prompt
        so gemma can bind pronouns to real referents instead of 'self'."""
        captured = {}

        async def fake_generate(**kwargs):
            captured.update(kwargs)
            return VALID_LLM_RESPONSE

        decomposer._client.generate = AsyncMock(side_effect=fake_generate)
        await decomposer.decompose(
            "tell me about him",
            known_subjects={"self": "Jesse", "people": ["Tom", "Camilla"], "entities": ["Avatar: Fire and Ash"]},
        )
        prompt = captured["prompt"]
        assert "KNOWN_SUBJECTS:" in prompt
        assert "self=Jesse" in prompt
        assert "Tom" in prompt
        assert "Camilla" in prompt
        assert "Avatar: Fire and Ash" in prompt

    @pytest.mark.anyio
    async def test_known_subjects_omitted_when_not_provided(self, decomposer):
        """Backwards compat: callers without a registry still work, and
        no KNOWN_SUBJECTS block leaks into the prompt."""
        captured = {}

        async def fake_generate(**kwargs):
            captured.update(kwargs)
            return VALID_LLM_RESPONSE

        decomposer._client.generate = AsyncMock(side_effect=fake_generate)
        await decomposer.decompose("hello")
        assert "KNOWN_SUBJECTS:" not in captured["prompt"]

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
        assert result.asks[0].context_source == "external"
        assert result.asks[0].referent_type == "event"
        assert result.asks[0].durability == "ephemeral"
        assert result.asks[0].needs_referent_resolution is False
        assert result.asks[0].capability_need == "web_search"

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
    async def test_decompose_parses_structured_routing_fields(self, decomposer):
        decomposer._client.generate = AsyncMock(return_value=STRUCTURED_ROUTING_RESPONSE)

        result = await decomposer.decompose("whats the name")

        ask = result.asks[0]
        assert ask.context_source == "recent_context"
        assert ask.referent_type == "media"
        assert ask.durability == "ephemeral"
        assert ask.needs_referent_resolution is True
        assert ask.capability_need == "none"

    @pytest.mark.anyio
    async def test_decompose_defaults_structured_routing_fields(self, decomposer):
        partial = json.dumps({
            "is_course_correction": False,
            "overall_reasoning_complexity": "fast",
            "short_term_memory": {"sentiment": "neutral", "concern": ""},
            "long_term_memory": [],
            "asks": [{
                "ask_id": "ask_001",
                "intent": "direct_chat",
                "distilled_query": "hello",
                "parameters": {},
                "response_shape": "synthesized",
                "requires_current_data": False,
                "knowledge_source": "none",
            }],
        })
        decomposer._client.generate = AsyncMock(return_value=partial)

        result = await decomposer.decompose("hello")

        ask = result.asks[0]
        assert ask.context_source == "none"
        assert ask.referent_type == "unknown"
        assert ask.durability == "durable"
        assert ask.needs_referent_resolution is False
        assert ask.capability_need == "none"

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

    @pytest.mark.anyio
    async def test_build_prompt_includes_mixed_companion_movie_rule(self, decomposer):
        decomposer._client.generate = AsyncMock(return_value=VALID_LLM_RESPONSE)

        await decomposer.decompose("maybe i'll go with my brother and see avatar tonight")

        call_args = decomposer._client.generate.call_args
        prompt = call_args.kwargs.get("prompt") or call_args[0][1]
        # The companion-doesn't-change-routing rule lives under
        # MEDIA-IN-THEATERS in prompts/decomposition.py.
        assert "Companion mentions" in prompt or "Companion details" in prompt
        assert "current_media" in prompt


    @pytest.mark.anyio
    async def test_decompose_parses_people_lookup_capability(self, decomposer):
        """capability_need='people_lookup' must survive parsing — it routes
        personal relationship mentions (\"who is my sister\", \"I should call
        my brother\") to the people graph skill."""
        response = json.dumps({
            "is_course_correction": False,
            "overall_reasoning_complexity": "fast",
            "short_term_memory": {"sentiment": "neutral", "concern": "none"},
            "long_term_memory": [],
            "asks": [{
                "ask_id": "1",
                "intent": "direct_chat",
                "distilled_query": "who is my sister",
                "parameters": {"relation": "sister"},
                "response_shape": "synthesized",
                "requires_current_data": False,
                "knowledge_source": "none",
                "context_source": "long_term_memory",
                "referent_type": "person",
                "durability": "durable",
                "needs_referent_resolution": True,
                "capability_need": "people_lookup",
                "referent_status": "unresolved",
                "referent_scope": ["person"],
                "referent_anchor": "my sister",
            }],
        })
        decomposer._client.generate = AsyncMock(return_value=response)

        result = await decomposer.decompose("who is my sister")

        ask = result.asks[0]
        assert ask.capability_need == "people_lookup"
        assert ask.referent_type == "person"
        assert ask.context_source == "long_term_memory"
        assert ask.parameters.get("relation") == "sister"


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
        assert ask.context_source == "none"
        assert ask.referent_type == "unknown"
        assert ask.durability == "durable"
        assert ask.needs_referent_resolution is False
        assert ask.capability_need == "none"

    def test_ask_default_parameters(self):
        ask = Ask(ask_id="ask_001", intent="direct_chat", distilled_query="hello")
        assert ask.parameters == {}


# ---- Prompt budget guardrails ----
# These tests enforce the budget ceilings documented in CLAUDE.md under
# "Prompt Budget Discipline". If you intentionally grow the prompt or
# schema, update the constants here and document why in your commit.

PROMPT_CHAR_CEILING = 8_000
ASK_REQUIRED_FIELD_CEILING = 12


class TestPromptBudget:
    def test_decomposition_prompt_size_under_budget(self):
        """The decomposition prompt must stay under the char budget.

        Every char is latency paid on every user turn. If this test
        fails, compress the prompt before merging — see CLAUDE.md
        'Prompt Budget Discipline'.
        """
        from lokidoki.core.prompts import DECOMPOSITION_PROMPT

        size = len(DECOMPOSITION_PROMPT)
        assert size <= PROMPT_CHAR_CEILING, (
            f"DECOMPOSITION_PROMPT is {size} chars, budget is {PROMPT_CHAR_CEILING}. "
            f"Compress rules/examples or derive fields in Python."
        )

    def test_ask_schema_required_field_count(self):
        """Keep ask schema fields bounded — each required field adds
        constrained-decoder branching time on every inference call."""
        from lokidoki.core.decomposer import DECOMPOSITION_SCHEMA

        ask_schema = DECOMPOSITION_SCHEMA["properties"]["asks"]["items"]
        count = len(ask_schema["required"])
        assert count <= ASK_REQUIRED_FIELD_CEILING, (
            f"Ask schema has {count} required fields, ceiling is "
            f"{ASK_REQUIRED_FIELD_CEILING}. Derive new fields in Python "
            f"instead of adding them to the schema."
        )

    def test_full_prompt_fits_in_context_window(self):
        """A realistic prompt (with AVAILABLE_INTENTS, KNOWN_SUBJECTS,
        RECENT_CONTEXT, and USER_INPUT) must fit in the decomposer's
        num_ctx with room for output tokens."""
        from lokidoki.core.prompts import DECOMPOSITION_PROMPT

        # Simulate worst-case dynamic additions
        intents = ",".join([f"skill_{i}.action" for i in range(15)])
        subjects = "KNOWN_SUBJECTS:self=Jesse|people=[" + ",".join([f"Person{i} (friend)" for i in range(10)]) + "]|entities=[Movie A,Movie B,Game C]"
        context = "RECENT_CONTEXT:" + " | ".join([f"user:msg{i} | assistant:{'x' * 240}" for i in range(5)])
        user_input = "USER_INPUT:" + "x" * 200

        full = "\n".join([DECOMPOSITION_PROMPT, f"AVAILABLE_INTENTS:{intents}", subjects, context, user_input])

        # ~4 chars per token is a conservative estimate for English.
        # num_ctx=8192 minus num_predict=384 = 7808 tokens for prompt.
        estimated_tokens = len(full) / 4
        max_input_tokens = 8192 - 384
        assert estimated_tokens <= max_input_tokens, (
            f"Full prompt ~{estimated_tokens:.0f} tokens exceeds input "
            f"budget of {max_input_tokens} tokens (num_ctx=8192 - num_predict=384). "
            f"Compress the base prompt."
        )


class TestDerivedFields:
    """Verify that fields removed from the schema are correctly derived."""

    def test_context_source_from_people_lookup(self):
        assert Decomposer._derive_context_source("people_lookup", False) == "long_term_memory"

    def test_context_source_from_external_capabilities(self):
        for cap in ("encyclopedic", "web_search", "current_media"):
            assert Decomposer._derive_context_source(cap, False) == "external"

    def test_context_source_from_needs_resolution(self):
        assert Decomposer._derive_context_source("none", True) == "recent_context"

    def test_context_source_default(self):
        assert Decomposer._derive_context_source("none", False) == "none"

    def test_referent_scope_from_known_types(self):
        for t in ("person", "media", "entity", "event"):
            assert Decomposer._derive_referent_scope(t) == [t]

    def test_referent_scope_unknown(self):
        assert Decomposer._derive_referent_scope("unknown") == []

    @pytest.mark.anyio
    async def test_build_ask_derives_all_fields(self):
        """End-to-end: _build_ask should populate context_source,
        referent_status, and referent_scope from primary fields."""
        mock_client = AsyncMock()
        d = Decomposer(inference_client=mock_client, model="gemma4:e2b")

        ask = d._build_ask({
            "ask_id": "1",
            "intent": "direct_chat",
            "distilled_query": "who is my brother",
            "parameters": {"relation": "brother"},
            "response_shape": "synthesized",
            "requires_current_data": False,
            "knowledge_source": "none",
            "referent_type": "person",
            "durability": "durable",
            "needs_referent_resolution": True,
            "capability_need": "people_lookup",
            "referent_anchor": "my brother",
        }, 0, "who is my brother")

        assert ask.context_source == "long_term_memory"
        assert ask.referent_status == "unresolved"
        assert ask.referent_scope == ["person"]

    @pytest.mark.anyio
    async def test_build_ask_derives_none_defaults(self):
        """When primary fields are defaults, derived fields should be defaults too."""
        mock_client = AsyncMock()
        d = Decomposer(inference_client=mock_client, model="gemma4:e2b")

        ask = d._build_ask({
            "ask_id": "1",
            "intent": "direct_chat",
            "distilled_query": "hello",
        }, 0, "hello")

        assert ask.context_source == "none"
        assert ask.referent_status == "none"
        assert ask.referent_scope == []
