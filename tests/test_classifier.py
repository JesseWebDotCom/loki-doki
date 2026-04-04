"""Tests for Phase 3 classification behavior."""

from __future__ import annotations

import unittest

from app.classifier import classify_message


class ClassifierTests(unittest.TestCase):
    """Verify request classification rules."""

    def test_simple_query_uses_simple_route(self) -> None:
        result = classify_message("hello")
        self.assertEqual(result.request_type, "static_text")
        self.assertEqual(result.route, "static_text")

    def test_how_are_you_uses_simple_route(self) -> None:
        result = classify_message("how are you")
        self.assertEqual(result.request_type, "static_text")
        self.assertEqual(result.route, "static_text")

    def test_who_are_you_uses_simple_route(self) -> None:
        result = classify_message("who are you?")
        self.assertEqual(result.request_type, "static_text")
        self.assertEqual(result.route, "static_text")

    def test_what_is_your_name_uses_simple_route(self) -> None:
        result = classify_message("what is your name?")
        self.assertEqual(result.request_type, "static_text")
        self.assertEqual(result.route, "static_text")

    def test_short_greeting_with_name_uses_simple_route(self) -> None:
        result = classify_message("hi lokidoki")
        self.assertEqual(result.request_type, "static_text")
        self.assertEqual(result.route, "static_text")

    def test_time_command_uses_local_command_route(self) -> None:
        result = classify_message("What time is it?")
        self.assertEqual(result.request_type, "command_call")
        self.assertEqual(result.route, "local_command")

    def test_short_prompt_uses_fast_qwen(self) -> None:
        result = classify_message("Tell me a joke about penguins")
        self.assertEqual(result.request_type, "text_chat")
        self.assertEqual(result.route, "fast_qwen")

    def test_complex_prompt_uses_thinking_qwen(self) -> None:
        result = classify_message("Compare two database designs and explain the tradeoffs")
        self.assertEqual(result.request_type, "text_chat")
        self.assertEqual(result.route, "thinking_qwen")

    def test_web_keywords_use_web_route(self) -> None:
        result = classify_message("Search the web for local weather")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_age_question_routes_to_web_query(self) -> None:
        result = classify_message("how old is shadow stevens")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_president_question_routes_to_web_query(self) -> None:
        result = classify_message("who is president")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_current_president_question_routes_to_web_query(self) -> None:
        result = classify_message("who is the current president")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_showtimes_question_routes_to_web_query(self) -> None:
        result = classify_message("what new movies are playing at the milford ct theater tonight")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_web_query_tolerates_typos_in_keywords(self) -> None:
        result = classify_message("what new movies are playing at the milford ct theater tongiht")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_recent_codex_throttling_question_routes_to_web_query(self) -> None:
        result = classify_message("did chatgpt recently change how it throttles codex?")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_product_code_lookup_routes_to_web_query(self) -> None:
        result = classify_message("what meta glasses are these: wayfarer 062Y")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_general_joke_request_stays_in_text_chat(self) -> None:
        result = classify_message("tell me a joke about penguins")
        self.assertEqual(result.request_type, "text_chat")
        self.assertEqual(result.route, "fast_qwen")

    def test_tool_keywords_use_function_route(self) -> None:
        result = classify_message("Open the settings panel")
        self.assertEqual(result.request_type, "tool_call")
        self.assertEqual(result.route, "function_model")


    def test_conversational_lookup_prefix_routes_to_web_query(self) -> None:
        result = classify_message("Do you know who Angine de Poitrine is?")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_wikipedia_keyword_routes_to_web_query(self) -> None:
        result = classify_message("search wikipedia for this")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")

    def test_tell_me_about_prefix_routes_to_web_query(self) -> None:
        result = classify_message("tell me about the band Angine de Poitrine")
        self.assertEqual(result.request_type, "web_query")
        self.assertEqual(result.route, "web_search")


if __name__ == "__main__":
    unittest.main()
