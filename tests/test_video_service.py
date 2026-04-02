"""Tests for Phase 4 video analysis service."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.providers.types import ProviderSpec
from app.subsystems.text.client import ProviderRequestError
from app.subsystems.video.service import VideoAnalysisError, analyze_video


FRAME_DATA_URL = "data:image/jpeg;base64,ZmFrZV9mcmFtZQ=="


def provider(name: str, backend: str, model: str, endpoint: str | None) -> ProviderSpec:
    """Build a provider spec for video-service tests."""
    return ProviderSpec(
        name=name,
        backend=backend,
        model=model,
        acceleration="cpu",
        endpoint=endpoint,
        fallback_backend="ollama" if backend != "ollama" else None,
    )


class VideoServiceTests(unittest.TestCase):
    """Verify video analysis provider routing."""

    @patch(
        "app.subsystems.video.service.analyze_with_provider",
        side_effect=["A person opens a door.", "A person walks into the room."],
    )
    def test_analyze_video_uses_sampled_frames(self, mock_analyze) -> None:
        result = analyze_video(
            [FRAME_DATA_URL, FRAME_DATA_URL],
            "Summarize the clip",
            "mac",
            {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
        )

        self.assertEqual(result.provider.name, "vision")
        self.assertIn("Frame 1: A person opens a door.", result.reply)
        self.assertIn("Frame 2: A person walks into the room.", result.reply)
        self.assertEqual(mock_analyze.call_count, 2)

    @patch(
        "app.subsystems.video.service.analyze_with_provider",
        side_effect=[ProviderRequestError("hailo unavailable"), "A cat sits on a sofa."],
    )
    def test_analyze_video_uses_cpu_fallback_when_hailo_request_fails(self, mock_analyze) -> None:
        result = analyze_video(
            [FRAME_DATA_URL],
            "",
            "pi_hailo",
            {"vision": provider("vision", "hailort", "Qwen2-VL-2B-Instruct.hef", None)},
        )

        self.assertEqual(result.provider.name, "vision_fallback")
        self.assertIn("Across the sampled frames", result.reply)
        self.assertEqual(mock_analyze.call_args_list[-1].args[0].backend, "ollama")

    def test_analyze_video_requires_frames(self) -> None:
        with self.assertRaises(VideoAnalysisError):
            analyze_video(
                [],
                "",
                "mac",
                {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
            )

    def test_analyze_video_rejects_too_many_frames(self) -> None:
        with self.assertRaises(VideoAnalysisError):
            analyze_video(
                [FRAME_DATA_URL] * 7,
                "",
                "mac",
                {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
            )


if __name__ == "__main__":
    unittest.main()
