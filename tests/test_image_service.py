"""Tests for Phase 4 image analysis service."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.providers.types import ProviderSpec
from app.subsystems.image.client import analyze_image_completion
from app.subsystems.image.response import clean_image_reply
from app.subsystems.image.service import ImageAnalysisError, analyze_image
from app.subsystems.text.client import ProviderRequestError


DATA_URL = "data:image/png;base64,ZmFrZV9pbWFnZQ=="


def provider(name: str, backend: str, model: str, endpoint: str | None) -> ProviderSpec:
    """Build a provider spec for image-service tests."""
    return ProviderSpec(
        name=name,
        backend=backend,
        model=model,
        acceleration="cpu",
        endpoint=endpoint,
        fallback_backend="ollama" if backend != "ollama" else None,
    )


class ImageServiceTests(unittest.TestCase):
    """Verify image analysis provider routing."""

    @patch("app.subsystems.image.service.analyze_with_provider", return_value="A framed photo on a shelf.")
    def test_analyze_image_uses_hailo_provider_when_available(self, mock_completion) -> None:
        result = analyze_image(
            DATA_URL,
            "Describe it",
            "pi_hailo",
            {"vision": provider("vision", "hailort", "Qwen2-VL-2B-Instruct.hef", None)},
        )

        self.assertEqual(result.reply, "A framed photo on a shelf.")
        self.assertEqual(result.provider.name, "vision")
        self.assertEqual(result.provider.backend, "hailort")
        args = mock_completion.call_args.args
        self.assertEqual(args[0].model, "Qwen2-VL-2B-Instruct.hef")
        self.assertEqual(args[1], "Describe it")

    @patch("app.subsystems.image.service.analyze_with_provider", return_value="A desk with a keyboard.")
    def test_analyze_image_uses_vision_provider(self, mock_completion) -> None:
        result = analyze_image(
            DATA_URL,
            "Describe it",
            "mac",
            {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
        )

        self.assertEqual(result.reply, "A desk with a keyboard.")
        self.assertEqual(result.provider.name, "vision")
        args = mock_completion.call_args.args
        self.assertEqual(args[0].model, "llava:7b")
        self.assertEqual(args[1], "Describe it")
        self.assertEqual(args[2], "ZmFrZV9pbWFnZQ==")

    @patch("app.subsystems.image.service.analyze_with_provider", side_effect=[ProviderRequestError("hailo runtime unavailable"), "A living room scene."])
    @patch(
        "app.subsystems.image.service.fallback_provider_for",
        return_value=ProviderSpec(
            name="vision_fallback",
            backend="ollama",
            model="moondream:latest",
            acceleration="cpu",
            endpoint="http://127.0.0.1:11434",
        ),
    )
    def test_analyze_image_uses_cpu_fallback_when_hailo_request_fails(self, _mock_fallback, mock_completion) -> None:
        result = analyze_image(
            DATA_URL,
            "",
            "pi_hailo",
            {"vision": provider("vision", "hailort", "Qwen2-VL-2B-Instruct.hef", None)},
        )

        self.assertEqual(result.reply, "A living room scene.")
        self.assertEqual(result.provider.name, "vision_fallback")
        args = mock_completion.call_args_list[-1].args
        self.assertEqual(args[0].backend, "ollama")
        self.assertEqual(args[0].model, "moondream:latest")

    def test_invalid_data_url_raises_image_analysis_error(self) -> None:
        with self.assertRaises(ImageAnalysisError):
            analyze_image(
                "not-a-data-url",
                "Describe it",
                "mac",
                {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
            )

    def test_oversized_data_url_raises_image_analysis_error(self) -> None:
        oversized = "data:image/jpeg;base64," + ("a" * 1_500_001)
        with self.assertRaises(ImageAnalysisError):
            analyze_image(
                oversized,
                "Describe it",
                "mac",
                {"vision": provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434")},
            )

    @patch("urllib.request.urlopen", side_effect=BrokenPipeError("broken pipe"))
    def test_client_wraps_os_errors_as_provider_request_error(self, _mock_urlopen) -> None:
        with self.assertRaises(ProviderRequestError):
            analyze_image_completion(
                provider("vision", "ollama", "llava:7b", "http://127.0.0.1:11434"),
                "Describe it",
                "ZmFrZQ==",
            )

    def test_clean_image_reply_strips_control_tokens(self) -> None:
        cleaned = clean_image_reply("A scene with people.<|im_end|>")

        self.assertEqual(cleaned, "A scene with people.")

    def test_clean_image_reply_keeps_normal_text(self) -> None:
        cleaned = clean_image_reply("A bright room with a window.")

        self.assertEqual(cleaned, "A bright room with a window.")


if __name__ == "__main__":
    unittest.main()
