"""Tests for authenticated voice and wakeword routes."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())

from app import db
from app.classifier import Classification
from app.providers.types import ProviderSpec
from app.settings import store
from app.subsystems.voice.workflow import VoiceChatResult
from app import main


def provider() -> ProviderSpec:
    """Build a provider spec for route tests."""
    return ProviderSpec(
        name="llm_fast",
        backend="ollama",
        model="qwen-fast",
        acceleration="cpu",
        endpoint="http://127.0.0.1:11434",
    )


class VoiceRouteTests(unittest.TestCase):
    """Verify Phase 5 routes persist and return the expected payloads."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.bootstrap_config_path = Path(self._temp_dir.name) / "bootstrap_config.json"
        self.app_config = replace(
            main.APP_CONFIG,
            database_path=self.database_path,
            bootstrap_config_path=self.bootstrap_config_path,
        )
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._config_patch = patch.object(main, "APP_CONFIG", self.app_config)
        self._config_patch.start()
        with main.connection_scope() as connection:
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed-password")

    def tearDown(self) -> None:
        self._config_patch.stop()
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._temp_dir.cleanup()

    def test_update_settings_persists_voice_preferences(self) -> None:
        payload = main.SettingsRequest(
            voice_reply_enabled=False,
            voice_source="piper",
            browser_voice_uri="voice://browser",
            piper_voice_id="en_US-amy-medium",
            barge_in_enabled=True,
        )

        result = main.update_settings(payload, current_user=self.user)

        self.assertFalse(result["voice_reply_enabled"])
        self.assertEqual(result["voice_source"], "piper")
        self.assertEqual(result["piper_voice_id"], "en_US-amy-medium")
        self.assertTrue(result["barge_in_enabled"])
        with main.connection_scope() as connection:
            preferences = store.load_voice_preferences(connection, self.user["id"])
        self.assertFalse(preferences["reply_enabled"])
        self.assertEqual(preferences["browser_voice_uri"], "voice://browser")
        self.assertTrue(preferences["barge_in_enabled"])

    @patch("app.main.runtime_context")
    @patch("app.main.route_message")
    @patch("app.main.transcribe_audio")
    def test_voice_chat_persists_transcript_and_reply(
        self,
        mock_transcribe_audio,
        mock_route_message,
        mock_runtime_context,
    ) -> None:
        mock_runtime_context.return_value = {
            "models": {"stt_model": "faster-whisper base.en"},
            "settings": {"profile": "mac"},
            "providers": {"llm_fast": provider(), "llm_thinking": provider()},
        }
        mock_transcribe_audio.return_value = "Tell me a joke"
        mock_route_message.return_value = VoiceChatResult(
            transcript="Tell me a joke",
            reply="Here is a joke.",
            provider=provider(),
            classification=Classification("text_chat", "fast_qwen", "short prompt"),
        )

        response = main.voice_chat(
            main.VoiceChatRequest(audio_base64="ZmFrZQ==", mime_type="audio/webm"),
            current_user=self.user,
        )

        self.assertEqual(response["transcript"], "Tell me a joke")
        self.assertEqual(response["message"]["content"], "Here is a joke.")
        self.assertEqual(response["message"]["meta"]["execution"]["model"], "qwen-fast")
        with main.connection_scope() as connection:
            history = store.load_chat_history(connection, self.user["id"])
        self.assertEqual(history[0]["content"], "Tell me a joke")
        self.assertEqual(history[1]["content"], "Here is a joke.")

    def test_detect_wakeword_returns_disabled_payload_when_preference_is_off(self) -> None:
        with main.connection_scope() as connection:
            store.save_wakeword_preferences(connection, self.user["id"], {"enabled": False})

        response = main.detect_wakeword(
            main.WakewordDetectRequest(audio_base64="ZmFrZQ==", sample_rate=16000),
            current_user=self.user,
        )

        self.assertFalse(response["detected"])
        self.assertFalse(response["ready"])
        self.assertEqual(response["detail"], "Wakeword is disabled.")

    def test_detect_wakeword_uses_session_manager_when_enabled(self) -> None:
        with main.connection_scope() as connection:
            store.save_wakeword_preferences(
                connection,
                self.user["id"],
                {"enabled": True, "model_id": "loki_doki", "threshold": 0.61},
            )
        with (
            patch("app.main.list_wakeword_sources") as mock_sources,
            patch.object(main.APP.state.wakeword_sessions, "detect") as mock_detect,
        ):
            mock_sources.return_value = [
                type(
                    "WakewordSourceStub",
                    (),
                    {"id": "loki_doki", "to_dict": lambda self: {"id": "loki_doki"}},
                )()
            ]
            mock_detect.return_value.to_dict.return_value = {
                "detected": True,
                "score": 0.91,
                "ready": True,
                "detail": "Wakeword detected.",
                "model_id": "loki_doki",
            }
            response = main.detect_wakeword(
                main.WakewordDetectRequest(audio_base64="ZmFrZQ==", sample_rate=16000),
                current_user=self.user,
            )

            self.assertTrue(response["detected"])
            mock_detect.assert_called_once_with(self.user["id"], "loki_doki", 0.61, "ZmFrZQ==", 16000)

    @patch("app.providers.piper_service.synthesize_stream")
    def test_stream_voice_post_returns_ndjson_chunks(self, mock_synthesize_stream) -> None:
        with main.connection_scope() as connection:
            store.save_voice_preferences(connection, self.user["id"], {"voice_source": "piper", "piper_voice_id": "en_US-lessac-medium"})

        mock_synthesize_stream.return_value = iter(
            [
                {
                    "audio_pcm": b"\x01\x02",
                    "sample_rate": 22050,
                    "phonemes": ["a"],
                    "samples_per_phoneme": 64,
                }
            ]
        )

        response = main.stream_voice_post(
            main.VoiceStreamRequest(text="hello", voice_id="en_US-lessac-medium"),
            current_user=self.user,
        )

        payload = []

        async def collect() -> None:
            async for chunk in response.body_iterator:
                payload.append(chunk)

        import asyncio

        asyncio.run(collect())

        body = b"".join(
            item.encode("utf-8") if isinstance(item, str) else item
            for item in payload
        ).decode("utf-8")

        self.assertIn('"sample_rate": 22050', body)
        self.assertIn('"phonemes": ["a"]', body)


if __name__ == "__main__":
    unittest.main()
