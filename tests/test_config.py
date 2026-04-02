"""Tests for bootstrap config normalization."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.config import get_face_recognition_defaults, load_bootstrap_config


class ConfigTests(unittest.TestCase):
    """Verify saved bootstrap configs are merged with current defaults."""

    def test_load_bootstrap_config_fills_missing_model_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "bootstrap_config.json"
            path.write_text(
                json.dumps(
                    {
                        "profile": "pi_hailo",
                        "models": {
                            "llm_fast": "qwen2.5-instruct:1.5b",
                            "tts_voice": "en_US-cori-medium",
                        },
                    }
                ),
                encoding="utf-8",
            )

            config = load_bootstrap_config(path)

            self.assertEqual(config["models"]["llm_fast"], "qwen2.5-instruct:1.5b")
            self.assertEqual(config["models"]["tts_voice"], "en_US-lessac-medium")
            self.assertEqual(config["models"]["object_detector_model"], "yolov8m_h10.hef")
            self.assertEqual(config["models"]["face_detector_model"], "yolov5s_personface.hef")

    def test_face_recognition_defaults_expose_quality_thresholds(self) -> None:
        defaults = get_face_recognition_defaults("pi_hailo")

        self.assertEqual(defaults["recognition_threshold"], 0.4)
        self.assertEqual(defaults["min_face_size_px"], 80.0)
        self.assertGreater(defaults["sharpness_threshold"], 0.0)


if __name__ == "__main__":
    unittest.main()
