"""Tests for the LokiDoki skill system runtime."""

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

from app import db
from app.config import get_app_config
from app.skills.response import build_skill_render_payload
from app.skills import skill_service
from app.skills.types import RouteCandidate, RouteDecision, SkillExecutionResult


class SkillServiceTests(unittest.TestCase):
    """Verify skill install, routing, and execution behavior."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root_config = get_app_config()
        self.database_path = Path(self.tempdir.name) / "lokidoki.db"
        self.config = replace(
            root_config,
            data_dir=Path(self.tempdir.name),
            database_path=self.database_path,
            skills_installed_dir=Path(self.tempdir.name) / "skills" / "installed",
            skills_builtin_dir=root_config.skills_builtin_dir,
            skills_repo_index_path=root_config.skills_repo_index_path,
        )
        self.config.skills_installed_dir.mkdir(parents=True, exist_ok=True)
        self.conn = db.connect(self.database_path)
        db.initialize_database(self.conn)
        skill_service.initialize(self.conn, self.config)
        self.user = db.create_user(self.conn, "jesse", "Jesse", "hashed")
        self.root_dir = Path(__file__).resolve().parents[1]

    def tearDown(self) -> None:
        self.conn.close()
        self.tempdir.cleanup()

    def test_builtin_web_search_is_registered(self) -> None:
        skills = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        web_search = next(skill for skill in skills if skill["skill_id"] == "web_search")
        self.assertTrue(web_search["system"])
        self.assertTrue(web_search["enabled"])
        self.assertTrue(str(web_search["logo"]).startswith("data:image/svg+xml;base64,"))
        self.assertEqual({skill["skill_id"] for skill in skills}, {"web_search"})

    def test_repository_skills_remain_available_until_installed(self) -> None:
        available = skill_service.list_available(self.conn, self.config)
        installed = skill_service.list_installed_for_user(self.conn, self.config, self.user)

        self.assertTrue(any(skill["id"] == "weather" for skill in available))
        self.assertTrue(any(skill["id"] == "home_assistant" for skill in available))
        self.assertEqual({skill["skill_id"] for skill in installed}, {"web_search"})

    def test_repository_skill_can_be_installed_and_listed(self) -> None:
        installed = skill_service.install_skill(self.conn, self.config, "weather")
        self.assertEqual(installed["skill_id"], "weather")
        self.assertTrue(installed["enabled"])
        available = skill_service.list_available(self.conn, self.config)
        weather = next(skill for skill in available if skill["id"] == "weather")
        home_assistant = next(skill for skill in available if skill["id"] == "home_assistant")
        self.assertTrue(weather["installed"])
        self.assertFalse(home_assistant["installed"])

    def test_skill_router_executes_weather_skill(self) -> None:
        skill_service.install_skill(self.conn, self.config, "weather")
        result = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "what's the weather in Milford, CT today?",
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["message"]["meta"]["request_type"], "skill_call")
        self.assertEqual(result["message"]["meta"]["route"], "weather.get_weather")
        self.assertIn("Milford", result["message"]["content"])

    def test_skill_router_uses_weather_for_condition_question(self) -> None:
        skill_service.install_skill(self.conn, self.config, "weather")
        skill_service.save_shared_context(
            self.conn,
            self.config,
            self.user,
            "weather",
            {"location": "Milford, CT", "timezone": "America/New_York"},
        )
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "is it going to snow?",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertIsNotNone(decision["candidate"])
        assert decision["candidate"] is not None
        self.assertEqual(decision["candidate"]["skill_id"], "weather")
        self.assertEqual(decision["candidate"]["action"], "get_weather")

    def test_weather_reply_mentions_requested_snow_context(self) -> None:
        module = self._load_skill_module("weather")
        summary = module._weather_summary(
            {
                "location": "Milford, CT",
                "description": "Partly cloudy",
                "high_temp_f": "55",
                "low_temp_f": "36",
                "chance_of_rain": "0",
                "chance_of_snow": "0",
                "chance_of_sleet": "0",
            },
            "i heard it's going to snow",
            "Milford, CT",
        )
        self.assertIn("don't see snow", summary.lower())

    def test_weather_reply_mentions_later_rain_when_peak_is_high(self) -> None:
        module = self._load_skill_module("weather")
        summary = module._weather_summary(
            {
                "location": "Milford, CT",
                "description": "Partly cloudy",
                "high_temp_f": "55",
                "low_temp_f": "36",
                "chance_of_rain": "38",
                "peak_chance_of_rain": "100",
                "chance_of_snow": "0",
                "chance_of_sleet": "0",
            },
            "tell me today's plan",
            "Milford, CT",
        )
        self.assertIn("rain risk builds later", summary.lower())
        self.assertIn("100%", summary)

    def test_weather_skill_prefers_specific_requested_location_label(self) -> None:
        module = self._load_skill_module("weather")
        self.assertEqual(
            module._preferred_location("Milford, CT", "Milford"),
            "Milford, CT",
        )

    def test_skill_render_payload_compacts_large_skill_data(self) -> None:
        payload = build_skill_render_payload(
            {
                "ok": True,
                "skill": "example",
                "action": "run",
                "presentation": {"type": "summary"},
                "errors": [],
                "data": {
                    "summary": "A" * 400,
                    "items": list(range(10)),
                    "nested": {"a": "1", "b": "2", "c": "3"},
                },
            },
            "Short reply",
            {"type": "summary", "title": "Example", "detail": "Detail text"},
            {"outcome": "skill_call", "reason": "matched"},
        )
        self.assertEqual(payload["reply"], "Short reply")
        self.assertEqual(payload["presentation_type"], "summary")
        self.assertEqual(payload["route"]["outcome"], "skill_call")
        self.assertEqual(len(payload["data"]["items"]), 5)
        self.assertTrue(str(payload["data"]["summary"]).endswith("..."))

    def test_shopping_list_skill_persists_shared_items(self) -> None:
        skill_service.install_skill(self.conn, self.config, "shopping_list")
        added = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "add milk to the shopping list",
        )
        listed = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "what's on the shopping list",
        )
        self.assertIsNotNone(added)
        self.assertIsNotNone(listed)
        assert listed is not None
        self.assertIn("Milk", listed["message"]["content"])

    def test_family_calendar_skill_reads_back_added_event(self) -> None:
        skill_service.install_skill(self.conn, self.config, "family_calendar")
        skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "add soccer practice tomorrow at 5 pm to the family calendar",
        )
        agenda = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "what's on the family calendar tomorrow",
        )
        self.assertIsNotNone(agenda)
        assert agenda is not None
        self.assertIn("Soccer Practice", agenda["message"]["content"])

    def test_reminders_skill_persists_per_user(self) -> None:
        skill_service.install_skill(self.conn, self.config, "reminders")
        skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "remind me to take out the trash tomorrow at 7 pm",
        )
        reminders = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "what are my reminders",
        )
        self.assertIsNotNone(reminders)
        assert reminders is not None
        self.assertIn("Take Out The Trash", reminders["message"]["content"])

    def test_movie_details_skill_uses_search_results(self) -> None:
        module = self._load_skill_module("movies")
        with patch.object(module, "parsed_search_results") as mock_results:
            mock_results.return_value = [
                {
                    "title": "Mickey 17 - IMDb",
                    "snippet": "Runtime 137 min. Rated R. Includes a post-credit scene.",
                    "source": "duckduckgo",
                }
            ]
            result = module._details_result("does mickey 17 have a post credit scene")
        self.assertTrue(result["ok"])
        self.assertIn("post-credit scene", result["data"]["summary"].lower())

    def test_movie_showtimes_parse_tomorrow_without_fake_location(self) -> None:
        module = self._load_skill_module("movies")
        parsed = module._parse_showtime_request("show me the movie showtimes for tomorrow", {})
        self.assertEqual(parsed.date_label, "tomorrow")
        self.assertEqual(parsed.location, "")
        self.assertEqual(parsed.movie_title, "")

    def test_movie_showtimes_parse_title_and_location_separately(self) -> None:
        module = self._load_skill_module("movies")
        parsed = module._parse_showtime_request(
            "What are the movie showtimes for Sinners in Milford, CT today?",
            {},
        )
        self.assertEqual(parsed.movie_title, "Sinners")
        self.assertEqual(parsed.location, "Milford, CT")

    def test_movie_showtimes_filter_out_article_results(self) -> None:
        module = self._load_skill_module("movies")
        parsed = module.ShowtimeRequest(movie_title="", location="", date_label="today", time_after_label="", theater_name="")
        self.assertFalse(
            module._looks_like_showtime_result(
                "Backstage Bonds, Swiftie Support, and Tayvis Calls: 13 Things We Learned From 'The End of an Era'",
                "Celebrity coverage and backstage recap.",
                parsed,
            )
        )
        self.assertTrue(
            module._looks_like_showtime_result(
                "AMC Plainville 20 Showtimes",
                "Showtimes today at 1:30 PM, 4:45 PM, 7:10 PM, 9:40 PM.",
                parsed,
            )
        )

    def test_movie_showtimes_use_location_date_and_time_filter(self) -> None:
        module = self._load_skill_module("movies")
        with patch.object(module, "parsed_search_results") as mock_results:
            mock_results.side_effect = [
                [
                    {
                        "title": "Taylor Swift feature article",
                        "snippet": "Backstage Bonds and celebrity analysis.",
                        "source": "duckduckgo",
                    }
                ],
                [
                    {
                        "title": "Cinemark North Haven Showtimes",
                        "snippet": "Movie times tomorrow at 4:20 PM, 5:40 PM, 8:15 PM.",
                        "source": "duckduckgo",
                    }
                ],
                [],
            ]
            result = module._showtimes_result(
                "show me the movie showtimes for north haven tomorrow after 5pm",
                {"location": "", "theater_name": ""},
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["movie_title"], "")
        self.assertEqual(result["data"]["location"], "North Haven")
        self.assertEqual(result["data"]["date"], "tomorrow")
        self.assertEqual(result["data"]["time_after"], "5 PM")
        self.assertIn("North Haven tomorrow after 5 PM", result["data"]["summary"])
        self.assertIn("5:40 PM", result["data"]["summary"])
        self.assertNotIn("4:20 PM", result["data"]["summary"])
        self.assertEqual(result["data"]["showtime_entries"][0]["times"], ["4:20 PM", "5:40 PM", "8:15 PM"])

    def test_skill_route_execution_includes_structured_render_payload(self) -> None:
        skill_service.install_skill(self.conn, self.config, "movies")
        result = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "show me the movie showtimes for today",
        )
        self.assertIsNotNone(result)
        assert result is not None
        payload = result["message"]["meta"]["render_payload"]
        self.assertIn("route", payload)
        self.assertEqual(payload["route"]["outcome"], "skill_call")

    def test_movie_router_accepts_singular_movie_phrasing(self) -> None:
        skill_service.install_skill(self.conn, self.config, "movies")
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "what movie are playing tonight",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertIsNotNone(decision["candidate"])
        assert decision["candidate"] is not None
        self.assertEqual(decision["candidate"]["skill_id"], "movies")
        self.assertEqual(decision["candidate"]["action"], "get_showtimes")

    def test_skill_loader_registers_module_for_movie_skill(self) -> None:
        skill_service.install_skill(self.conn, self.config, "movies")
        result = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "show me the movie showtimes for today",
        )
        self.assertIsNotNone(result)

    def test_route_inspection_reports_no_skill_for_general_chat(self) -> None:
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "tell me a joke about penguins",
        )
        self.assertEqual(decision["outcome"], "no_skill")

    def test_web_search_router_handles_recent_product_and_reference_queries(self) -> None:
        prompts = (
            "did chatgpt recently change how it throttles codex?",
            "is there a noise cancellation earbuds to combat tinnitus",
            "what meta glasses are these: wayfarer 062Y",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                decision = skill_service.inspect_route(
                    self.conn,
                    self.config,
                    self.user,
                    "mac",
                    prompt,
                )
                self.assertEqual(decision["outcome"], "skill_call")
                self.assertIsNotNone(decision["candidate"])
                assert decision["candidate"] is not None
                self.assertEqual(decision["candidate"]["skill_id"], "web_search")
                self.assertEqual(decision["candidate"]["action"], "search")

    def test_web_search_router_handles_long_embedded_fact_question(self) -> None:
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "there was no finale to the show taxi but did any of the actors or staff ever mention what one would have been?",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertIsNotNone(decision["candidate"])
        assert decision["candidate"] is not None
        self.assertEqual(decision["candidate"]["skill_id"], "web_search")
        self.assertEqual(decision["candidate"]["action"], "search")

    def test_home_assistant_router_treats_direct_command_as_skill_call(self) -> None:
        skill_service.install_skill(self.conn, self.config, "home_assistant")
        skill_service.set_enabled(self.conn, self.config, "home_assistant", True)
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "turn on the living room ceiling fan",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertEqual(decision["candidate"]["skill_id"], "home_assistant")
        self.assertEqual(decision["candidate"]["action"], "turn_on")

    def test_home_assistant_router_ignores_narrative_turn_on_phrase(self) -> None:
        skill_service.install_skill(self.conn, self.config, "home_assistant")
        skill_service.set_enabled(self.conn, self.config, "home_assistant", True)
        decision = skill_service.inspect_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "When I went to turn on the tv, I tripped",
        )
        self.assertEqual(decision["outcome"], "no_skill")

    def test_skill_shared_context_persists_per_user(self) -> None:
        skill_service.install_skill(self.conn, self.config, "weather")
        values = skill_service.save_shared_context(
            self.conn,
            self.config,
            self.user,
            "weather",
            {"location": "Milford, CT", "timezone": "America/New_York"},
        )
        skills = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        weather = next(skill for skill in skills if skill["skill_id"] == "weather")
        self.assertEqual(values["location"], "Milford, CT")
        self.assertEqual(weather["shared_context"]["location"], "Milford, CT")

    def test_skill_test_route_returns_json_safe_context(self) -> None:
        result = skill_service.test_route(
            self.conn,
            self.config,
            self.user,
            "mac",
            "tell me a joke about penguins",
        )
        self.assertEqual(result["context"]["profile"], "mac")
        self.assertEqual(result["context"]["username"], "jesse")
        self.assertNotIn("accounts", result["context"])

    def test_execute_with_fallbacks_uses_configured_chain_until_success(self) -> None:
        route = RouteDecision(
            outcome="skill_call",
            reason="primary",
            candidate=RouteCandidate(skill_id="tv_shows", action="get_show_details", score=5.0, reason="primary"),
        )
        failed = SkillExecutionResult(
            ok=False,
            skill_id="tv_shows",
            action="get_show_details",
            route=route,
            result={"ok": False, "skill": "tv_shows", "action": "get_show_details", "errors": ["not found"]},
            reply="not found",
            card={"type": "error"},
            meta={"route": "tv_shows.get_show_details"},
        )
        fallback_route = RouteDecision(
            outcome="skill_call",
            reason="fallback",
            candidate=RouteCandidate(skill_id="wikipedia", action="lookup_article", score=0.0, reason="fallback"),
        )
        succeeded = SkillExecutionResult(
            ok=True,
            skill_id="wikipedia",
            action="lookup_article",
            route=fallback_route,
            result={"ok": True, "skill": "wikipedia", "action": "lookup_article", "errors": []},
            reply="Marc Singer is an actor.",
            card={"type": "summary"},
            meta={"route": "wikipedia.lookup_article"},
        )

        with patch.object(skill_service, "_execute_route", side_effect=[failed, succeeded]) as mock_execute:
            execution = skill_service._execute_with_fallbacks(
                self.conn,
                self.config,
                {"profile": "mac"},
                "do you know who marc singer is",
                route,
            )

        self.assertTrue(execution.ok)
        self.assertEqual(execution.skill_id, "wikipedia")
        self.assertEqual(execution.meta["fallback_from"], "tv_shows.get_show_details")
        self.assertEqual(
            execution.meta["fallback_attempts"],
            ["tv_shows.get_show_details", "wikipedia.lookup_article"],
        )
        self.assertEqual(mock_execute.call_count, 2)

    def test_execute_with_fallbacks_returns_original_failure_when_chain_fails(self) -> None:
        route = RouteDecision(
            outcome="skill_call",
            reason="primary",
            candidate=RouteCandidate(skill_id="wikipedia", action="lookup_article", score=5.0, reason="primary"),
        )
        failed = SkillExecutionResult(
            ok=False,
            skill_id="wikipedia",
            action="lookup_article",
            route=route,
            result={"ok": False, "skill": "wikipedia", "action": "lookup_article", "errors": ["not found"]},
            reply="not found",
            card={"type": "error"},
            meta={"route": "wikipedia.lookup_article"},
        )
        fallback_route = RouteDecision(
            outcome="skill_call",
            reason="fallback",
            candidate=RouteCandidate(skill_id="web_search", action="search", score=0.0, reason="fallback"),
        )
        fallback_failed = SkillExecutionResult(
            ok=False,
            skill_id="web_search",
            action="search",
            route=fallback_route,
            result={"ok": False, "skill": "web_search", "action": "search", "errors": ["no results"]},
            reply="no results",
            card={"type": "error"},
            meta={"route": "web_search.search"},
        )

        with patch.object(skill_service, "_execute_route", side_effect=[failed, fallback_failed]):
            execution = skill_service._execute_with_fallbacks(
                self.conn,
                self.config,
                {"profile": "mac"},
                "wikipedia obscure topic",
                route,
            )

        self.assertFalse(execution.ok)
        self.assertEqual(execution.skill_id, "wikipedia")
        self.assertEqual(execution.meta["fallback_attempts"], ["wikipedia.lookup_article", "web_search.search"])

    def test_identity_lookup_prefers_wikipedia_when_installed(self) -> None:
        local_config = replace(
            self.config,
            skills_repository_index_url="file:///Users/jessetorres/Projects/loki-doki-skills/index.json",
        )
        skill_service.install_skill(self.conn, local_config, "wikipedia")
        decision = skill_service.inspect_route(
            self.conn,
            local_config,
            self.user,
            "mac",
            "who is Louie DePalma",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertIsNotNone(decision["candidate"])
        assert decision["candidate"] is not None
        self.assertEqual(decision["candidate"]["skill_id"], "wikipedia")
        self.assertEqual(decision["candidate"]["action"], "lookup_article")

    def test_entertainment_lookup_prefers_tv_shows_when_installed(self) -> None:
        local_config = replace(
            self.config,
            skills_repository_index_url="file:///Users/jessetorres/Projects/loki-doki-skills/index.json",
        )
        skill_service.install_skill(self.conn, local_config, "tv_shows")
        decision = skill_service.inspect_route(
            self.conn,
            local_config,
            self.user,
            "mac",
            "who was in Taxi",
        )
        self.assertEqual(decision["outcome"], "skill_call")
        self.assertIsNotNone(decision["candidate"])
        assert decision["candidate"] is not None
        self.assertEqual(decision["candidate"]["skill_id"], "tv_shows")
        self.assertEqual(decision["candidate"]["action"], "get_show_cast")

    def _load_skill_module(self, skill_id: str):
        """Load one repository skill module directly from disk for unit tests."""
        skill_service.install_skill(self.conn, self.config, skill_id)
        skill_path = self.config.skills_installed_dir / skill_id / "skill.py"
        module_name = f"test_skill_{skill_id}"
        spec = importlib.util.spec_from_file_location(module_name, skill_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module


if __name__ == "__main__":
    unittest.main()
