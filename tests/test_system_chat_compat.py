"""Compatibility tests for app shell routes and settings."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())

from app import db
import app.deps as deps
from app.api import system as system_api
from app.main import create_app
from app.models.settings import SettingsRequest


class SystemChatCompatibilityTests(unittest.TestCase):
    """Verify route aliases and settings persistence used by the React shell."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        temp_root = Path(self._temp_dir.name)
        self.app_config = replace(
            deps.APP_CONFIG,
            database_path=temp_root / "lokidoki.db",
            bootstrap_config_path=temp_root / "bootstrap_config.json",
            data_dir=temp_root / ".lokidoki",
        )
        self.app_config.data_dir.mkdir(parents=True, exist_ok=True)
        deps._DB_READY = False
        self._deps_config_patch = patch.object(deps, "APP_CONFIG", self.app_config)
        self._system_config_patch = patch.object(system_api, "APP_CONFIG", self.app_config)
        self._deps_config_patch.start()
        self._system_config_patch.start()
        with deps.connection_scope() as connection:
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed-password")
            db.set_user_admin_flag(connection, self.user["id"], True)

    def tearDown(self) -> None:
        self._system_config_patch.stop()
        self._deps_config_patch.stop()
        deps._DB_READY = False
        self._temp_dir.cleanup()

    def test_create_app_includes_legacy_chat_alias_routes(self) -> None:
        """The frontend legacy singular chat routes should remain mounted."""
        app = create_app()
        routes = {getattr(route, "path", "") for route in app.routes}

        self.assertIn("/api/chat/stream", routes)
        self.assertIn("/api/chat/retry-smart", routes)

    def test_update_settings_persists_theme_without_attribute_error(self) -> None:
        """Settings updates should use the real db setter and return refreshed settings."""
        payload = system_api.update_settings(
            SettingsRequest(theme="dark", debug_mode=True, voice_reply_enabled=False),
            current_user=self.user,
        )

        self.assertEqual(payload["theme"], "dark")
        self.assertFalse(payload["voice_reply_enabled"])
        with deps.connection_scope() as connection:
            self.assertEqual(db.get_user_setting(connection, self.user["id"], "theme", "system"), "dark")

    def test_debug_logs_route_returns_sections_for_admin(self) -> None:
        """Admin debug log fetches should return local log sections."""
        (self.app_config.data_dir / "app.log").write_text("one\ntwo\n", encoding="utf-8")

        payload = system_api.get_debug_logs(current_user={**self.user, "is_admin": True})

        self.assertTrue(any(section["key"] == "app" for section in payload["sections"]))


if __name__ == "__main__":
    unittest.main()
