"""Regression tests for the administration voice API."""

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
from app.api import admin_voices


class AdminVoiceApiTests(unittest.TestCase):
    """Verify admin voice routes expose installed Piper voices to the UI."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        temp_root = Path(self._temp_dir.name)
        self.app_config = replace(
            deps.APP_CONFIG,
            database_path=temp_root / "lokidoki.db",
            bootstrap_config_path=temp_root / "bootstrap_config.json",
        )
        deps._DB_READY = False
        self._deps_config_patch = patch.object(deps, "APP_CONFIG", self.app_config)
        self._admin_voice_config_patch = patch.object(admin_voices, "APP_CONFIG", self.app_config)
        self._deps_config_patch.start()
        self._admin_voice_config_patch.start()
        with deps.connection_scope() as connection:
            self.user = db.create_user(connection, "admin", "Admin", "hashed-password")
            db.set_user_admin_flag(connection, self.user["id"], True)
        self.current_user = {**self.user, "is_admin": True}

    def tearDown(self) -> None:
        self._admin_voice_config_patch.stop()
        self._deps_config_patch.stop()
        deps._DB_READY = False
        self._temp_dir.cleanup()

    @patch("app.api.admin_voices.voice_catalog_status")
    @patch("app.api.admin_voices.voice_catalog")
    def test_list_admin_voices_includes_installed_records(
        self,
        mock_voice_catalog: MagicMock,
        mock_voice_catalog_status: MagicMock,
    ) -> None:
        """The admin catalog should surface installed voices instead of an empty list."""
        mock_voice_catalog.return_value = [
            {
                "id": "en_US-lessac-medium",
                "label": "Lessac",
                "language": "en_US",
                "quality": "medium",
                "description": "Clear neutral American English voice.",
                "installed": True,
                "synthesis_ready": True,
                "curated": True,
                "gender": "neutral",
                "model_url": "https://example.test/lessac.onnx",
                "config_url": "https://example.test/lessac.onnx.json",
            }
        ]
        mock_voice_catalog_status.return_value = {
            "source_url": "https://example.test/catalog.json",
            "fetched_at": 1.0,
            "voice_count": 1,
            "used_cache": True,
            "stale": False,
        }

        payload = admin_voices.list_admin_voices(current_user=self.current_user)

        self.assertEqual(len(payload["voices"]), 1)
        self.assertTrue(payload["voices"][0]["installed"])
        self.assertEqual(payload["voices"][0]["id"], "en_US-lessac-medium")
        self.assertIn("catalog_status", payload)

    @patch("app.api.admin_voices.synthesize", return_value=b"RIFF")
    def test_preview_admin_voice_returns_wav_response(self, mock_synthesize: MagicMock) -> None:
        """The admin preview route should return audio data for the selected voice."""
        response = admin_voices.preview_admin_voice(
            "en_US-lessac-medium",
            admin_voices.VoiceSpeakRequest(text="Lessac preview."),
            current_user=self.current_user,
        )

        self.assertEqual(response.media_type, "audio/wav")
        self.assertEqual(response.body, b"RIFF")
        mock_synthesize.assert_called_once_with("Lessac preview.", "en_US-lessac-medium")


if __name__ == "__main__":
    unittest.main()
