"""Tests for wakeword sources and runtime helpers."""

from __future__ import annotations

import base64
import unittest
from unittest.mock import patch

from app.subsystems.voice.wakeword import (
    WakewordSessionManager,
    list_wakeword_sources,
    wakeword_runtime_status,
)


class WakewordTests(unittest.TestCase):
    """Verify wakeword source discovery and detection session handling."""

    def test_builtin_lokidoki_source_is_listed(self) -> None:
        sources = list_wakeword_sources()
        source_ids = {source.id for source in sources}
        self.assertIn("loki_doki", source_ids)

    @patch("app.subsystems.voice.wakeword._openwakeword_importable", return_value=False)
    def test_runtime_status_reports_missing_engine(self, _mock_importable) -> None:
        payload = wakeword_runtime_status("loki_doki")
        self.assertFalse(payload["ready"])
        self.assertIn("openwakeword is not installed", str(payload["detail"]))

    @patch("app.subsystems.voice.wakeword._openwakeword_runtime_ready", return_value=(False, "resources missing"))
    def test_runtime_status_reports_missing_runtime_resources(self, _mock_runtime_ready) -> None:
        payload = wakeword_runtime_status("loki_doki")
        self.assertFalse(payload["ready"])
        self.assertIn("resources missing", str(payload["detail"]))

    @patch("app.subsystems.voice.wakeword.WakewordSessionManager._get_or_create_detector")
    def test_session_manager_returns_detection_result(self, mock_get_detector) -> None:
        manager = WakewordSessionManager()
        mock_get_detector.return_value.process_pcm16_chunk.return_value = (True, 0.82)
        audio_base64 = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")
        result = manager.detect("user-1", "loki_doki", 0.5, audio_base64, 16000)
        self.assertTrue(result.detected)
        self.assertEqual(result.model_id, "loki_doki")
        self.assertGreaterEqual(result.score, 0.82)


if __name__ == "__main__":
    unittest.main()
