"""Compatibility tests for the current voice API contract."""

from __future__ import annotations

import asyncio
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
from app.api import voice as voice_api
from app.chats import store as chat_store


class VoiceApiCompatibilityTests(unittest.TestCase):
    """Verify the backend matches the voice routes used by the React app."""

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
        self._voice_config_patch = patch.object(voice_api, "APP_CONFIG", self.app_config)
        self._deps_config_patch.start()
        self._voice_config_patch.start()
        with deps.connection_scope() as connection:
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed-password")
            self.chat = chat_store.ensure_active_chat(connection, self.user["id"])

    def tearDown(self) -> None:
        self._voice_config_patch.stop()
        self._deps_config_patch.stop()
        deps._DB_READY = False
        self._temp_dir.cleanup()

    @patch("app.api.voice.voice_catalog")
    @patch("app.api.voice.piper_status")
    def test_plural_voices_payload_matches_app_contract(self, mock_piper_status: MagicMock, mock_voice_catalog: MagicMock) -> None:
        """The app shell should be able to hydrate from /api/voices."""
        mock_piper_status.return_value = {
            "binary_ready": True,
            "binary_path": "/tmp/piper",
            "installed_voices": ["en_US-lessac-medium"],
            "selected_voice_installed": True,
        }
        mock_voice_catalog.return_value = [{"id": "en_US-lessac-medium", "label": "Lessac", "installed": True}]

        payload = voice_api.voices_payload_api(current_user=self.user)

        self.assertEqual(payload["voice_source"], "browser")
        self.assertIn("reply_enabled", payload)
        self.assertIn("barge_in_enabled", payload)
        self.assertEqual(payload["piper"]["catalog"][0]["id"], "en_US-lessac-medium")
        self.assertTrue(payload["piper"]["status"]["selected_voice_installed"])

    @patch("app.api.voice.list_wakeword_sources")
    @patch("app.api.voice.wakeword_runtime_status")
    def test_wakeword_payload_and_update_match_app_contract(
        self,
        mock_runtime_status: MagicMock,
        mock_sources: MagicMock,
    ) -> None:
        """The app shell should be able to read and update wakeword settings."""
        mock_sources.return_value = [
            type(
                "WakewordSourceStub",
                (),
                {
                    "to_dict": lambda self: {
                        "id": "loki_doki",
                        "label": "LokiDoki",
                        "model_path": "/tmp/loki_doki.onnx",
                        "phrases": ["loki doki"],
                        "installed": True,
                    }
                },
            )()
        ]
        mock_runtime_status.return_value = {
            "ready": True,
            "detail": "Wakeword detection is ready.",
            "engine_available": True,
            "model_id": "loki_doki",
            "source": {"id": "loki_doki"},
        }

        updated = voice_api.update_wakeword_api(
            voice_api.WakewordSettingsRequest(enabled=True, model_id="loki_doki", threshold=0.42),
            current_user=self.user,
        )

        self.assertTrue(updated["enabled"])
        self.assertEqual(updated["model_id"], "loki_doki")
        self.assertAlmostEqual(updated["threshold"], 0.42)
        self.assertEqual(updated["sources"][0]["id"], "loki_doki")
        self.assertTrue(updated["status"]["ready"])

    @patch("app.api.voice._stt_model_label", return_value="faster-whisper base.en")
    @patch("app.api.voice.transcribe_audio", return_value="hello loki")
    def test_transcribe_route_returns_transcript_key(
        self,
        mock_transcribe_audio: MagicMock,
        mock_model_label: MagicMock,
    ) -> None:
        """Push-to-talk transcription should return the transcript field the app reads."""
        payload = voice_api.voice_transcribe_api(
            voice_api.VoiceTranscribeRequest(audio_base64="ZmFrZQ==", mime_type="audio/webm"),
            current_user=self.user,
        )

        self.assertEqual(payload["transcript"], "hello loki")
        self.assertEqual(payload["text"], "hello loki")
        mock_model_label.assert_called_once_with()
        mock_transcribe_audio.assert_called_once_with("ZmFrZQ==", "audio/webm", "faster-whisper base.en")

    @patch("app.api.voice.synthesize_stream")
    def test_plural_voice_stream_returns_ndjson_chunks(self, mock_synthesize_stream: MagicMock) -> None:
        """The browser voice player should receive ndjson audio chunks from /api/voices/stream."""
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

        response = voice_api.voices_stream_api(
            voice_api.VoiceStreamRequest(text="hello"),
            current_user=self.user,
        )

        payload: list[str | bytes] = []

        async def collect() -> None:
            async for chunk in response.body_iterator:
                payload.append(chunk)

        asyncio.run(collect())
        body = b"".join(item.encode("utf-8") if isinstance(item, str) else item for item in payload).decode("utf-8")

        self.assertIn('"audio_base64"', body)
        self.assertIn('"sample_rate": 22050', body)
        self.assertIn('"phonemes": ["a"]', body)


if __name__ == "__main__":
    unittest.main()
