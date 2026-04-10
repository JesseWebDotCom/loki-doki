import pytest
import json
import os
import tempfile
from unittest.mock import patch
from lokidoki.api.routes.settings import _load_settings, _save_settings, DEFAULT_SETTINGS


class TestSettings:
    def test_load_defaults_when_no_file(self):
        with patch("lokidoki.core.settings_store.SETTINGS_FILE", "/nonexistent/path.json"):
            result = _load_settings()
        assert result == DEFAULT_SETTINGS

    def test_save_and_load_roundtrip(self, tmp_path):
        path = str(tmp_path / "settings.json")
        data = {"admin_prompt": "No profanity", "user_prompt": "Be kind", "piper_voice": "en_US-lessac-medium", "stt_model": "base", "read_aloud": True}

        with patch("lokidoki.core.settings_store.SETTINGS_FILE", path):
            _save_settings(data)
            loaded = _load_settings()

        assert loaded["admin_prompt"] == "No profanity"
        assert loaded["user_prompt"] == "Be kind"

    def test_load_merges_with_defaults(self, tmp_path):
        path = str(tmp_path / "settings.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump({"admin_prompt": "Safety first"}, f)

        with patch("lokidoki.core.settings_store.SETTINGS_FILE", path):
            loaded = _load_settings()

        assert loaded["admin_prompt"] == "Safety first"
        assert loaded["piper_voice"] == "en_US-lessac-medium"  # default preserved

    def test_load_handles_corrupt_json(self, tmp_path):
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            f.write("{broken json")

        with patch("lokidoki.core.settings_store.SETTINGS_FILE", path):
            loaded = _load_settings()

        assert loaded == DEFAULT_SETTINGS

    def test_load_includes_speech_naturalization_defaults(self, tmp_path):
        path = str(tmp_path / "settings.json")

        with patch("lokidoki.core.settings_store.SETTINGS_FILE", path):
            loaded = _load_settings()

        assert loaded["speech_rate"] == 1.0
        assert loaded["sentence_pause"] == 0.4
        assert loaded["normalize_text"] is True

    def test_load_includes_relationship_alias_defaults(self, tmp_path):
        path = str(tmp_path / "settings.json")

        with patch("lokidoki.core.settings_store.SETTINGS_FILE", path):
            loaded = _load_settings()

        assert "relationship_aliases" in loaded
        assert "mother" in loaded["relationship_aliases"]
        assert "mom" in loaded["relationship_aliases"]["mother"]
