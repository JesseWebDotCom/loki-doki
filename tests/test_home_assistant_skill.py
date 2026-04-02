"""Tests for the Home Assistant skill runtime."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db
from app.config import get_app_config
from app.skills.registry import SkillRegistry
from app.skills import skill_service


class HomeAssistantSkillTests(unittest.TestCase):
    """Verify Home Assistant account selection and command execution."""

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
        skill_service.install_skill(self.conn, self.config, "home_assistant")
        skill_service.set_enabled(self.conn, self.config, "home_assistant", True)
        skill_service._loader.clear("home_assistant")

    def tearDown(self) -> None:
        self.conn.close()
        self.tempdir.cleanup()

    def test_single_account_turn_on_works_without_site_name(self) -> None:
        self._save_account("Home", True, default_area="living room")
        module = self._load_runtime_module()
        states = [self._entity("light.living_room", "Living Room Light")]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "turn on the living room light",
            )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("Living Room Light is now on", result["message"]["content"])
        mock_post.assert_called_once_with(
            "http://home.local:8123",
            "token-home",
            "/api/services/light/turn_on",
            {"entity_id": "light.living_room"},
        )

    def test_new_home_assistant_skill_starts_unconfigured(self) -> None:
        loaded = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        skill_payload = next(skill for skill in loaded if skill["skill_id"] == "home_assistant")
        self.assertEqual(skill_payload["health_status"], "unknown")
        self.assertEqual(skill_payload["health_detail"], "No accounts configured.")

    def test_multiple_accounts_pick_explicit_site_alias(self) -> None:
        self._save_account("Home", False, site_aliases="house")
        self._save_account("Work", False, site_aliases="office,workplace")
        module = self._load_runtime_module()
        states_by_base_url = {
            "http://home.local:8123": [self._entity("light.living_room", "Home Living Room Light")],
            "http://work.local:8123": [self._entity("light.living_room", "Work Living Room Light")],
        }

        def fake_get(base_url: str, token: str, path: str):
            self.assertEqual(path, "/api/states")
            return states_by_base_url[base_url]

        with patch.object(module, "api_get", side_effect=fake_get), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "turn on the living room light at work",
            )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("at Work", result["message"]["content"])
        mock_post.assert_called_once_with(
            "http://work.local:8123",
            "token-work",
            "/api/services/light/turn_on",
            {"entity_id": "light.living_room"},
        )

    def test_multiple_accounts_without_default_require_disambiguation(self) -> None:
        self._save_account("Home", False)
        self._save_account("Work", False)
        result = skill_service.route_and_execute(
            self.conn,
            self.config,
            self.user,
            "mac",
            "turn on the living room light",
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("Choose which Home Assistant instance to use", result["message"]["content"])

    def test_set_level_routes_to_fan_percentage_service(self) -> None:
        self._save_account("Home", True)
        module = self._load_runtime_module()
        states = [self._entity("fan.living_room", "Living Room Fan")]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "set the living room fan to 50%",
            )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("50%", result["message"]["content"])
        mock_post.assert_called_once_with(
            "http://home.local:8123",
            "token-home",
            "/api/services/fan/set_percentage",
            {"entity_id": "fan.living_room", "percentage": 50},
        )

    def test_ambiguous_fan_request_returns_clarification_candidates(self) -> None:
        self._save_account("Home", True)
        module = self._load_runtime_module()
        states = [
            self._entity("fan.living_room_ceiling", "Living Room Ceiling Fan"),
            self._entity("fan.bedroom_ceiling", "Bedroom Ceiling Fan"),
        ]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "set the ceiling fan to 50%",
            )
        self.assertIsNotNone(result)
        assert result is not None
        skill_result = result["message"]["meta"]["skill_result"]
        self.assertEqual(skill_result["presentation"]["type"], "clarification")
        self.assertEqual(len(skill_result["data"]["candidates"]), 2)
        self.assertIn("Living Room Ceiling Fan", result["message"]["content"])
        self.assertIn("Bedroom Ceiling Fan", result["message"]["content"])
        mock_post.assert_not_called()

    def test_generic_fan_names_are_expanded_in_clarification_candidates(self) -> None:
        self._save_account("Home", True)
        module = self._load_runtime_module()
        states = [
            self._entity("fan.master_bedroom_rear", "Fan"),
            self._entity("fan.living_room", "Fan"),
            self._entity("fan.living_room_air_purifier", "Fan"),
        ]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "is the fan on",
            )
        self.assertIsNotNone(result)
        assert result is not None
        candidates = result["message"]["meta"]["skill_result"]["data"]["candidates"]
        labels = [candidate["friendly_name"] for candidate in candidates]
        self.assertEqual(
            labels,
            [
                "Master Bedroom Rear Fan",
                "Living Room Fan",
                "Living Room Air Purifier Fan",
            ],
        )
        self.assertIn("Living Room Air Purifier Fan", result["message"]["content"])
        mock_post.assert_not_called()

    def test_entity_name_falls_back_to_readable_label_without_friendly_name(self) -> None:
        self._save_account("home", True)
        module = self._load_runtime_module()
        states = [{"entity_id": "fan.master_bedroom_rear", "state": "off", "attributes": {}}]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post"):
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "turn off fan master bedroom rear",
            )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("Master Bedroom Rear Fan", result["message"]["content"])
        self.assertNotIn("fan.master_bedroom_rear", result["message"]["content"])

    def test_specific_room_request_does_not_guess_wrong_fan(self) -> None:
        self._save_account("Home", True)
        module = self._load_runtime_module()
        states = [{"entity_id": "fan.master_bedroom_rear", "state": "off", "attributes": {}}]
        with patch.object(module, "api_get", return_value=states), patch.object(module, "api_post") as mock_post:
            result = skill_service.route_and_execute(
                self.conn,
                self.config,
                self.user,
                "mac",
                "set the living room ceiling fan to 50%",
            )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIn("couldn't match", result["message"]["content"].lower())
        mock_post.assert_not_called()

    def test_account_connection_test_updates_health(self) -> None:
        self._save_account("Home", True)
        module = self._load_runtime_module()

        def fake_get(base_url: str, token: str, path: str):
            if path == "/api/":
                return {"location_name": "Home", "version": "2026.3.0"}
            if path == "/api/states":
                return [self._entity("light.kitchen", "Kitchen Light")]
            raise AssertionError(path)

        installed = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        skill_payload = next(skill for skill in installed if skill["skill_id"] == "home_assistant")
        account_id = skill_payload["accounts"][0]["id"]
        with patch.object(module, "api_get", side_effect=fake_get):
            result = skill_service.test_account_connection(
                self.conn,
                self.config,
                "home_assistant",
                account_id,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "ok")
        self.assertIn("Connected to Home Assistant", result["detail"])
        loaded = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        skill_payload = next(skill for skill in loaded if skill["skill_id"] == "home_assistant")
        self.assertEqual(skill_payload["health_status"], "ok")
        self.assertEqual(skill_payload["accounts"][0]["health_status"], "ok")

    def test_successful_connection_test_enables_skill(self) -> None:
        skill_service.set_enabled(self.conn, self.config, "home_assistant", False)
        self._save_account("Home", True)
        module = self._load_runtime_module()

        def fake_get(base_url: str, token: str, path: str):
            if path == "/api/":
                return {"location_name": "Home"}
            if path == "/api/states":
                return []
            raise AssertionError(path)

        installed = skill_service.list_installed_for_user(self.conn, self.config, self.user)
        skill_payload = next(skill for skill in installed if skill["skill_id"] == "home_assistant")
        account_id = skill_payload["accounts"][0]["id"]
        with patch.object(module, "api_get", side_effect=fake_get):
            result = skill_service.test_account_connection(
                self.conn,
                self.config,
                "home_assistant",
                account_id,
            )
        self.assertTrue(result["ok"])
        refreshed = next(
            skill for skill in skill_service.list_installed_for_user(self.conn, self.config, self.user)
            if skill["skill_id"] == "home_assistant"
        )
        self.assertTrue(refreshed["enabled"])

    def _save_account(
        self,
        label: str,
        is_default: bool,
        *,
        default_area: str = "",
        site_aliases: str = "",
    ) -> None:
        slug = label.lower()
        skill_service.save_account(
            self.conn,
            self.config,
            "home_assistant",
            label,
            {},
            {
                "base_url": f"http://{slug}.local:8123",
                "access_token": f"token-{slug}",
                "default_area": default_area,
                "site_aliases": site_aliases,
            },
            is_default=is_default,
        )

    def _load_runtime_module(self):
        record = SkillRegistry(self.config.skills_builtin_dir).get(self.conn, "home_assistant")
        assert record is not None
        skill_service._loader.clear("home_assistant")
        skill_service._loader.load(record)
        return sys.modules["lokidoki_skill_home_assistant"]

    @staticmethod
    def _entity(entity_id: str, friendly_name: str) -> dict[str, object]:
        return {
            "entity_id": entity_id,
            "state": "off",
            "attributes": {"friendly_name": friendly_name},
        }
