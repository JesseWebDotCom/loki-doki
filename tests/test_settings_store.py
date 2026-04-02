"""Tests for settings persistence helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app import db
from app.settings import store


class SettingsStoreTests(unittest.TestCase):
    """Verify voice and wakeword settings persist with safe defaults."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.connection = db.connect(self.database_path)
        db.initialize_database(self.connection)
        user = db.create_user(self.connection, "jesse", "Jesse", "hashed-password")
        self.user_id = str(user["id"])

    def tearDown(self) -> None:
        self.connection.close()
        self._temp_dir.cleanup()

    def test_load_voice_preferences_normalizes_legacy_piper_voice(self) -> None:
        db.set_user_setting(
            self.connection,
            self.user_id,
            store.VOICE_PREFERENCES_KEY,
            {
                "reply_enabled": True,
                "voice_source": "piper",
                "browser_voice_uri": "",
                "piper_voice_id": "en_US-cori-medium",
            },
        )

        preferences = store.load_voice_preferences(self.connection, self.user_id)

        self.assertEqual(preferences["piper_voice_id"], "en_US-lessac-medium")
        self.assertEqual(preferences["voice_source"], "piper")

    def test_save_and_load_wakeword_preferences_normalize_types(self) -> None:
        store.save_wakeword_preferences(
            self.connection,
            self.user_id,
            {
                "enabled": 1,
                "model_id": "",
                "threshold": "0.72",
            },
        )

        preferences = store.load_wakeword_preferences(self.connection, self.user_id)

        self.assertTrue(preferences["enabled"])
        self.assertEqual(preferences["model_id"], "loki_doki")
        self.assertEqual(preferences["threshold"], 0.72)


if __name__ == "__main__":
    unittest.main()
