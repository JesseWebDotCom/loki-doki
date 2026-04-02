"""Tests for skill rendering helpers."""

from __future__ import annotations

import unittest

from app.skills.rendering import skill_render_context, skill_should_skip_character_render


class MainSkillRenderingTests(unittest.TestCase):
    """Verify grounded skill rendering behavior."""

    def setUp(self) -> None:
        self.skill_message = {
            "role": "assistant",
            "content": "In Milford, CT, it's clear with a high of 55 F and a low of 36 F. Rain risk builds later, with around a 32% overall chance and peaks near 100%.",
            "meta": {
                "request_type": "skill_call",
                "route": "weather.get_weather",
                "reason": "phrase:weather",
                "card": {"type": "weather_report", "title": "Weather for Milford, CT"},
                "skill_result": {
                    "ok": True,
                    "skill": "weather",
                    "action": "get_weather",
                    "presentation": {"type": "weather_report"},
                    "data": {
                        "location": "Milford, CT",
                        "summary": "In Milford, CT, it's clear with a high of 55 F and a low of 36 F. Rain risk builds later, with around a 32% overall chance and peaks near 100%.",
                        "peak_chance_of_rain": "100",
                    },
                    "errors": [],
                },
            },
        }

    def test_weather_skill_uses_character_render(self) -> None:
        self.assertFalse(skill_should_skip_character_render(self.skill_message))

    def test_skill_render_context_returns_summary_only(self) -> None:
        _, context = skill_render_context(
            self.skill_message,
            {"outcome": "skill_call", "reason": "phrase:weather"},
        )

        self.assertEqual(
            context,
            "In Milford, CT, it's clear with a high of 55 F and a low of 36 F. Rain risk builds later, with around a 32% overall chance and peaks near 100%.",
        )

    def test_home_assistant_state_change_uses_character_render_with_guardrails(self) -> None:
        message = {
            "role": "assistant",
            "content": "Living Room Ceiling Fan is now on.",
            "meta": {
                "request_type": "skill_call",
                "route": "home_assistant.turn_on",
                "render_payload": {
                    "ok": True,
                    "skill": "home_assistant",
                    "action": "turn_on",
                    "presentation_type": "entity_state_change",
                    "reply": "Living Room Ceiling Fan is now on.",
                    "data": {"summary": "Living Room Ceiling Fan is now on."},
                    "errors": [],
                    "route": {"outcome": "skill_call"},
                },
                "skill_result": {
                    "ok": True,
                    "skill": "home_assistant",
                    "action": "turn_on",
                    "presentation": {"type": "entity_state_change"},
                    "data": {"summary": "Living Room Ceiling Fan is now on."},
                    "errors": [],
                },
            },
        }
        self.assertFalse(skill_should_skip_character_render(message))
        _, context = skill_render_context(message)
        self.assertIn("compiled prompt voice", context)
        self.assertIn("Do not suggest manual steps", context)


if __name__ == "__main__":
    unittest.main()
