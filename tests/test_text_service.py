"""Tests for Phase 3 text routing and provider selection."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.classifier import Classification
from app.providers.types import ProviderSpec
from app.subsystems.character import CharacterRenderingContext
from app.subsystems.text.client import ProviderRequestError
from app.subsystems.text.service import TextChatError, generate_text_reply, stream_text_reply


def provider(name: str, model: str) -> ProviderSpec:
    """Build a provider spec for tests."""
    return ProviderSpec(
        name=name,
        backend="ollama",
        model=model,
        acceleration="cpu",
        endpoint="http://127.0.0.1:11434",
    )


class TextServiceTests(unittest.TestCase):
    """Verify text routing behavior."""

    def setUp(self) -> None:
        self.providers = {
            "llm_fast": provider("llm_fast", "fast-model"),
            "llm_thinking": provider("llm_thinking", "thinking-model"),
            "function_model": provider("function_model", "gemma-model"),
        }
        self.rendering_context = CharacterRenderingContext(
            user_id="user-1",
            account_id="default-account",
            display_name="Jesse",
            profile="mac",
            base_prompt="Base prompt",
            base_prompt_hash="hash-123",
            active_character_id="lokidoki",
            character_enabled=True,
            blocked_topics=(),
            max_response_tokens=160,
            debug={
                "prompt_hash": "hash-123",
                "cache_hit": False,
                "character_id": "lokidoki",
                "care_profile_id": "standard",
            },
        )

    @patch("app.subsystems.text.service.chat_completion", return_value="Fast reply")
    def test_fast_route_uses_fast_provider(self, mock_chat_completion) -> None:
        result = generate_text_reply(
            "Tell me a joke",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("text_chat", "fast_qwen", "short prompt"),
        )
        self.assertEqual(result.reply, "Fast reply")
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_chat_completion.call_args.args
        self.assertEqual(args[0].model, "fast-model")
        self.assertEqual(mock_chat_completion.call_args.kwargs["options"]["num_predict"], 128)

    def test_simple_query_uses_canned_reply(self) -> None:
        result = generate_text_reply(
            "Hi LokiDoki",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("static_text", "static_text", "greeting"),
        )
        self.assertIn("Hello", result.reply)
        self.assertEqual(result.provider.backend, "local")

    def test_identity_query_uses_canned_reply(self) -> None:
        result = generate_text_reply(
            "Who are you?",
            "Jesse",
            "pi_hailo",
            [],
            self.providers,
            Classification("static_text", "static_text", "identity"),
        )
        self.assertIn("LokiDoki", result.reply)
        self.assertIn("local-first assistant", result.reply)

    def test_name_query_uses_canned_reply(self) -> None:
        result = generate_text_reply(
            "What is your name?",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("static_text", "static_text", "identity"),
        )
        self.assertEqual(result.reply, "My name is LokiDoki.")
        self.assertEqual(result.provider.backend, "local")

    def test_stream_simple_query_uses_canned_reply(self) -> None:
        result = stream_text_reply(
            "how are you",
            "Jesse",
            "pi_hailo",
            [],
            self.providers,
            Classification("static_text", "static_text", "greeting"),
        )
        chunks = list(result.chunks)
        self.assertEqual(len(chunks), 1)
        self.assertIn("ready to help", chunks[0])
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.chat_completion", return_value="Structured reply")
    def test_structured_debug_includes_llm_messages_when_requested(self, _mock_chat_completion) -> None:
        result = generate_text_reply(
            "Tell me a joke",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("text_chat", "fast_qwen", "short prompt"),
            rendering_context=self.rendering_context,
            include_prompt_debug=True,
        )
        self.assertEqual(result.reply, "Structured reply")
        self.assertIsNotNone(result.debug)
        assert result.debug is not None
        self.assertTrue(result.debug["llm_used"])
        self.assertEqual(len(result.debug["llm_messages"]), 3)
        self.assertEqual(result.debug["llm_messages"][0]["role"], "system")
        self.assertIn("Base prompt", result.debug["llm_messages"][0]["content"])
        self.assertIsNone(result.parsed)

    @patch("app.subsystems.text.service.chat_completion", return_value="Detailed reply")
    def test_character_preferred_response_style_drives_default_render_instruction(self, _mock_chat_completion) -> None:
        detailed_context = CharacterRenderingContext(
            user_id="user-1",
            account_id="default-account",
            display_name="Jesse",
            profile="mac",
            base_prompt="Base prompt",
            base_prompt_hash="hash-123",
            active_character_id="tano",
            character_enabled=True,
            character_preferred_response_style="detailed",
            blocked_topics=(),
            max_response_tokens=160,
            debug={},
        )
        result = generate_text_reply(
            "Tell me about this topic",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("text_chat", "fast_qwen", "short prompt"),
            rendering_context=detailed_context,
            include_prompt_debug=True,
        )
        assert result.debug is not None
        self.assertIn("Provide a detailed but natural response", result.debug["llm_messages"][-1]["content"])

    @patch("app.subsystems.text.service.chat_completion", return_value="Today in Milford, CT, it will be partly cloudy")
    def test_character_render_returns_plain_text(self, _mock_chat_completion) -> None:
        result = generate_text_reply(
            "Give me today's weather",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("text_chat", "fast_qwen", "short prompt"),
            rendering_context=self.rendering_context,
        )
        self.assertEqual(result.reply, "Today in Milford, CT, it will be partly cloudy")
        self.assertIsNone(result.parsed)

    def test_command_call_uses_local_execution(self) -> None:
        result = generate_text_reply(
            "What profile are you on?",
            "Jesse",
            "pi_hailo",
            [],
            self.providers,
            Classification("command_call", "local_command", "profile command"),
        )
        self.assertEqual(result.reply, "The active runtime profile is pi_hailo.")
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.search_web")
    @patch("app.subsystems.text.service.chat_completion", return_value="Here is the live summary.")
    def test_web_query_summarizes_search_results_with_fast_model(
        self,
        mock_chat_completion,
        mock_search_web,
    ) -> None:
        mock_search_web.return_value.context = "SEARCH RESULTS for 'weather':\nTitle: Example\nSnippet: Sunny."
        result = generate_text_reply(
            "What happened in the news today?",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "web request"),
        )
        self.assertEqual(result.reply, "Here is the live summary.")
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_chat_completion.call_args.args
        self.assertEqual(args[0].model, "fast-model")
        self.assertIn("User request: What happened in the news today?", args[1][1]["content"])
        self.assertEqual(mock_chat_completion.call_args.kwargs["options"]["num_predict"], 768)

    @patch("app.subsystems.text.service.search_web")
    def test_weather_query_returns_deterministic_filled_values(self, mock_search_web) -> None:
        mock_search_web.return_value.source = "wttr.in"
        mock_search_web.return_value.context = "LIVE WEATHER DATA"
        mock_search_web.return_value.metadata = {
            "location": "Milford",
            "description": "Partly cloudy",
            "high_temp_f": "58",
            "low_temp_f": "44",
            "chance_of_rain": "20",
            "wind_mph": "11",
            "wind_direction": "NE",
        }
        result = generate_text_reply(
            "What's the weather in Milford, CT today?",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "weather request"),
        )
        self.assertIn("Milford", result.reply)
        self.assertIn("58 F", result.reply)
        self.assertIn("44 F", result.reply)
        self.assertIn("20% chance of rain", result.reply)
        self.assertNotIn("[insert", result.reply)
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.search_web")
    @patch("app.subsystems.text.service.chat_completion", return_value="Styled weather reply")
    def test_weather_query_uses_character_render_when_context_available(self, mock_chat_completion, mock_search_web) -> None:
        mock_search_web.return_value.source = "wttr.in"
        mock_search_web.return_value.context = "LIVE WEATHER DATA"
        mock_search_web.return_value.metadata = {
            "location": "Milford",
            "description": "Partly cloudy",
            "high_temp_f": "58",
            "low_temp_f": "44",
            "chance_of_rain": "20",
            "wind_mph": "11",
            "wind_direction": "NE",
        }
        result = generate_text_reply(
            "What's the weather in Milford, CT today?",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "weather request"),
            rendering_context=self.rendering_context,
            include_prompt_debug=True,
        )
        self.assertEqual(result.reply, "Styled weather reply")
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_chat_completion.call_args.args
        self.assertEqual(args[0].model, "fast-model")
        self.assertIn("Use the verified facts below as grounding, not as a script.", args[1][1]["content"])
        self.assertIn("Do not read the data mechanically or list every field one by one.", args[1][1]["content"])
        self.assertIn("Verified answer facts. Use these facts and do not contradict them.", args[1][1]["content"])
        self.assertIn('"kind": "weather"', args[1][1]["content"])
        self.assertIn('"location": "Milford"', args[1][1]["content"])
        self.assertNotIn("In Milford", args[1][1]["content"])
        self.assertIsNotNone(result.debug)
        assert result.debug is not None
        self.assertEqual(result.debug["deterministic_source"], "web_query")

    @patch("app.subsystems.text.service.chat_completion", return_value="Styled hello")
    def test_static_text_uses_character_render_when_context_available(self, mock_chat_completion) -> None:
        result = generate_text_reply(
            "Hi LokiDoki",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("static_text", "static_text", "greeting"),
            rendering_context=self.rendering_context,
            include_prompt_debug=True,
        )
        self.assertEqual(result.reply, "Styled hello")
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_chat_completion.call_args.args
        self.assertIn("Verified answer content. Use these facts and do not contradict them.", args[1][1]["content"])
        self.assertIn("Hello", args[1][1]["content"])

    @patch("app.subsystems.text.service.chat_completion", return_value="Styled tool reply")
    def test_tool_call_uses_character_render_when_context_available(self, mock_chat_completion) -> None:
        result = generate_text_reply(
            "Open the calendar",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("tool_call", "function_model", "tool request"),
            rendering_context=self.rendering_context,
        )
        self.assertEqual(result.reply, "Styled tool reply")
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_chat_completion.call_args.args
        self.assertIn("matched the tool route", args[1][1]["content"])

    @patch("app.subsystems.text.service.search_web")
    def test_person_age_query_returns_deterministic_answer(self, mock_search_web) -> None:
        mock_search_web.return_value.source = "duckduckgo"
        mock_search_web.return_value.context = (
            "SEARCH RESULTS for '\"marc singer\" age':\n"
            "Title: Marc Singer / Age\n"
            "Snippet: 78 years January 29, 1948\n"
            "---\n"
            "Title: Marc Singer\n"
            "Snippet: Born January 29, 1948, Vancouver, British Columbia, Canada. Age 78 years."
        )
        mock_search_web.return_value.metadata = {
            "kind": "person_age",
            "name": "Marc Singer",
        }
        result = generate_text_reply(
            "how old is marc singer",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "age request"),
        )
        self.assertEqual(result.reply, "Marc Singer is 78 years old. He was born on January 29, 1948.")
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.search_web")
    def test_office_holder_query_returns_deterministic_answer(self, mock_search_web) -> None:
        mock_search_web.return_value.source = "duckduckgo"
        mock_search_web.return_value.context = (
            "SEARCH RESULTS for 'current president of the united states':\n"
            "Title: President of the United States\n"
            "Snippet: Donald Trump is the current president of the United States.\n"
        )
        mock_search_web.return_value.metadata = {
            "kind": "office_holder",
            "office": "President of the United States",
        }
        result = generate_text_reply(
            "who is president",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "office request"),
        )
        self.assertEqual(result.reply, "The current president of the united states is Donald Trump.")
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.search_web")
    def test_web_query_returns_graceful_reply_when_search_fails(self, mock_search_web) -> None:
        mock_search_web.return_value.context = "SEARCH_ERROR"
        result = generate_text_reply(
            "What happened in the news today?",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("web_query", "web_search", "web request"),
        )
        self.assertIn("local web search fallback is unavailable", result.reply)
        self.assertEqual(result.provider.backend, "local")

    @patch("app.subsystems.text.service.chat_completion", return_value="Thinking reply")
    def test_thinking_route_uses_thinking_provider(self, mock_chat_completion) -> None:
        result = generate_text_reply(
            "Compare these plans and explain the tradeoffs",
            "Jesse",
            "mac",
            [{"role": "assistant", "content": "Previous answer"}],
            self.providers,
            Classification("text_chat", "thinking_qwen", "complex prompt"),
        )
        self.assertEqual(result.reply, "Thinking reply")
        self.assertEqual(result.provider.model, "thinking-model")
        args = mock_chat_completion.call_args.args
        self.assertEqual(args[0].model, "thinking-model")
        self.assertEqual(args[1][-1]["content"], "Compare these plans and explain the tradeoffs")
        self.assertEqual(mock_chat_completion.call_args.kwargs["options"]["num_predict"], 512)
        self.assertIn("Never claim to be fictional", args[1][0]["content"])

    def test_tool_call_uses_function_provider_placeholder(self) -> None:
        result = generate_text_reply(
            "Open the calendar",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("tool_call", "function_model", "tool request"),
        )
        self.assertIn("matched the tool route", result.reply)
        self.assertEqual(result.provider.model, "gemma-model")

    @patch("app.subsystems.text.service.chat_completion", side_effect=ProviderRequestError("down"))
    def test_provider_failures_raise_text_chat_error(self, _mock_chat_completion) -> None:
        with self.assertRaises(TextChatError) as error:
            generate_text_reply(
                "Explain this architecture",
                "Jesse",
                "mac",
                [],
                self.providers,
                Classification("text_chat", "thinking_qwen", "complex prompt"),
            )
        self.assertIn("Text chat is unavailable on the mac profile.", str(error.exception))
        self.assertIn("thinking-model", str(error.exception))

    @patch("app.subsystems.text.service.stream_chat_completion", return_value=iter(["Fast ", "reply"]))
    def test_stream_text_reply_yields_provider_chunks(self, mock_stream_chat_completion) -> None:
        result = stream_text_reply(
            "Tell me a joke",
            "Jesse",
            "mac",
            [],
            self.providers,
            Classification("text_chat", "fast_qwen", "short prompt"),
        )
        chunks = list(result.chunks)
        self.assertEqual(chunks, ["Fast reply"])
        self.assertEqual(result.provider.model, "fast-model")
        args = mock_stream_chat_completion.call_args.args
        self.assertEqual(args[0].model, "fast-model")
        self.assertIn("one or two short sentences", args[1][0]["content"])


if __name__ == "__main__":
    unittest.main()
