"""Tests for push-to-talk voice routing."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.classifier import Classification
from app.providers.types import ProviderSpec
from app.subsystems.voice.workflow import run_push_to_talk_turn


def provider() -> ProviderSpec:
    """Build a provider spec for voice workflow tests."""
    return ProviderSpec(
        name="llm_fast",
        backend="ollama",
        model="qwen-fast",
        acceleration="cpu",
        endpoint="http://127.0.0.1:11434",
    )


class VoiceWorkflowTests(unittest.TestCase):
    """Verify recorded voice clips flow through STT and chat routing."""

    @patch("app.subsystems.voice.workflow.route_message")
    @patch("app.subsystems.voice.workflow.transcribe_audio", return_value="Tell me a joke")
    def test_run_push_to_talk_turn_routes_transcript_through_chat(
        self,
        mock_transcribe_audio,
        mock_route_message,
    ) -> None:
        mock_route_message.return_value.reply = "Here is a joke."
        mock_route_message.return_value.provider = provider()
        mock_route_message.return_value.classification = Classification(
            "text_chat",
            "fast_qwen",
            "short prompt",
        )

        result = run_push_to_talk_turn(
            audio_base64="ZmFrZQ==",
            mime_type="audio/webm",
            stt_model="faster-whisper base.en",
            username="Jesse",
            profile="mac",
            history=[{"role": "assistant", "content": "Hi"}],
            providers={"llm_fast": provider()},
        )

        self.assertEqual(result.transcript, "Tell me a joke")
        self.assertEqual(result.reply, "Here is a joke.")
        self.assertEqual(result.provider.model, "qwen-fast")
        mock_transcribe_audio.assert_called_once_with("ZmFrZQ==", "audio/webm", "faster-whisper base.en")
        route_args = mock_route_message.call_args.args
        self.assertEqual(route_args[0], "Tell me a joke")
        self.assertEqual(route_args[1], "Jesse")
        self.assertEqual(route_args[2], "mac")


if __name__ == "__main__":
    unittest.main()
