"""Tests for orchestration metadata and provider tracking."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.classifier import Classification
from app.orchestrator import route_document_analysis, route_image_analysis, route_message, route_message_stream, route_video_analysis
from app.providers.types import ProviderSpec
from app.subsystems.video.service import VideoAnalysisResult
from app.subsystems.image.service import ImageAnalysisResult
from app.subsystems.text.service import TextReplyResult, TextStreamResult


def provider(name: str, backend: str, model: str, acceleration: str) -> ProviderSpec:
    """Build a provider spec for orchestrator tests."""
    return ProviderSpec(
        name=name,
        backend=backend,
        model=model,
        acceleration=acceleration,
        endpoint="http://127.0.0.1:11434" if backend == "ollama" else None,
    )


class OrchestratorTests(unittest.TestCase):
    """Verify orchestrator returns actual execution providers."""

    @patch("app.orchestrator.classify_message", return_value=Classification("text_chat", "fast_qwen", "short"))
    @patch("app.orchestrator.generate_text_reply")
    def test_route_message_includes_actual_provider(self, mock_generate, _mock_classify) -> None:
        mock_generate.return_value = TextReplyResult(
            reply="hello",
            provider=provider("llm_fast", "ollama", "qwen-fast", "cpu"),
        )

        result = route_message("hi", "Jesse", "mac", [], {})

        self.assertEqual(result.provider.model, "qwen-fast")
        self.assertEqual(result.reply, "hello")

    @patch("app.orchestrator.classify_message", return_value=Classification("static_text", "static_text", "greeting"))
    @patch("app.orchestrator.stream_text_reply")
    def test_route_message_stream_includes_actual_provider(self, mock_stream, _mock_classify) -> None:
        mock_stream.return_value = TextStreamResult(
            provider=provider("static_text", "local", "canned_response", "cpu"),
            chunks=iter(["hello"]),
        )

        result = route_message_stream("hi", "Jesse", "mac", [], {})

        self.assertEqual(result.provider.backend, "local")
        self.assertEqual(list(result.chunks), ["hello"])

    @patch("app.orchestrator.analyze_image")
    def test_route_image_analysis_uses_actual_provider_name_for_route(self, mock_analyze) -> None:
        mock_analyze.return_value = ImageAnalysisResult(
            reply="A room.",
            provider=provider("vision_fallback", "ollama", "moondream:latest", "cpu"),
        )

        result = route_image_analysis("data:image/png;base64,ZmFrZQ==", "", "pi_hailo", {})

        self.assertEqual(result.classification.route, "vision_fallback")
        self.assertEqual(result.provider.model, "moondream:latest")

    @patch("app.orchestrator.analyze_video")
    def test_route_video_analysis_uses_actual_provider_name_for_route(self, mock_analyze) -> None:
        mock_analyze.return_value = VideoAnalysisResult(
            reply="Video summary from sampled frames: Frame 1: A room.",
            provider=provider("vision", "ollama", "llava:7b", "cpu"),
        )

        result = route_video_analysis(["data:image/jpeg;base64,ZmFrZQ=="], "", "mac", {})

        self.assertEqual(result.classification.request_type, "video_analysis")
        self.assertEqual(result.classification.route, "vision")
        self.assertEqual(result.provider.model, "llava:7b")

    @patch("app.orchestrator.generate_text_reply")
    def test_route_document_analysis_uses_thinking_route_metadata(self, mock_generate) -> None:
        mock_generate.return_value = TextReplyResult(
            reply="This document is a rollout plan.",
            provider=provider("llm_thinking", "ollama", "qwen-thinking", "cpu"),
        )

        result = route_document_analysis(
            "Line one.\nLine two.",
            "What is the point of this document?",
            "plan.md",
            "Jesse",
            "mac",
            [],
            {},
        )

        self.assertEqual(result.classification.request_type, "document_analysis")
        self.assertEqual(result.classification.route, "thinking_qwen")
        self.assertEqual(result.provider.model, "qwen-thinking")
        prompt = mock_generate.call_args.args[0]
        self.assertIn("Document: plan.md", prompt)
        self.assertIn("What is the point of this document?", prompt)


if __name__ == "__main__":
    unittest.main()
