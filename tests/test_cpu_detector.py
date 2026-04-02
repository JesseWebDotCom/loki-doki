"""Tests for the CPU object detector."""

from __future__ import annotations

import base64
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from app.providers.types import ProviderSpec
from app.subsystems.live_video import cpu_detector
from app.subsystems.live_video.cpu_detector import detect_cpu_objects


def provider(model: str = "yolo11n") -> ProviderSpec:
    """Build a provider spec for CPU detector tests."""
    return ProviderSpec(
        name="object_detector",
        backend="cpu_detector",
        model=model,
        acceleration="cpu",
    )


def image_payload(size: tuple[int, int] = (100, 100)) -> str:
    """Return a base64 PNG payload for one RGB image."""
    image = Image.new("RGB", size, (255, 255, 255))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


class FakeInput:
    """Small ONNX input stub."""

    name = "images"


class FakeSession:
    """Small ONNX session stub."""

    def __init__(self, output: np.ndarray) -> None:
        self.output = output

    def get_inputs(self) -> list[FakeInput]:
        """Return the model input metadata."""
        return [FakeInput()]

    def run(self, _output_names: object, _inputs: object) -> list[np.ndarray]:
        """Return the preloaded output tensor."""
        return [self.output]


class CpuDetectorTests(unittest.TestCase):
    """Verify the CPU object detector decodes YOLO outputs."""

    @patch("app.subsystems.live_video.cpu_detector._session_for_model")
    def test_detect_cpu_objects_returns_normalized_detections(self, mock_session_for_model) -> None:
        output = np.zeros((1, 84, 2), dtype=np.float32)
        output[0, 0, 0] = 320.0
        output[0, 1, 0] = 320.0
        output[0, 2, 0] = 160.0
        output[0, 3, 0] = 160.0
        output[0, 4, 0] = 0.95
        output[0, 0, 1] = 100.0
        output[0, 1, 1] = 100.0
        output[0, 2, 1] = 80.0
        output[0, 3, 1] = 80.0
        output[0, 5, 1] = 0.05
        mock_session_for_model.return_value = FakeSession(output)

        detections = detect_cpu_objects(provider(), image_payload())

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["label"], "person")
        self.assertAlmostEqual(detections[0]["confidence"], 0.95, places=2)
        self.assertAlmostEqual(detections[0]["x"], 0.375, places=3)
        self.assertAlmostEqual(detections[0]["width"], 0.25, places=3)

    @patch("app.subsystems.live_video.cpu_detector._session_for_model")
    def test_detect_cpu_objects_applies_nms_per_class(self, mock_session_for_model) -> None:
        output = np.zeros((1, 84, 3), dtype=np.float32)
        output[0, 0, 0] = 320.0
        output[0, 1, 0] = 320.0
        output[0, 2, 0] = 200.0
        output[0, 3, 0] = 200.0
        output[0, 4, 0] = 0.95
        output[0, 0, 1] = 330.0
        output[0, 1, 1] = 330.0
        output[0, 2, 1] = 210.0
        output[0, 3, 1] = 210.0
        output[0, 4, 1] = 0.75
        output[0, 0, 2] = 500.0
        output[0, 1, 2] = 500.0
        output[0, 2, 2] = 80.0
        output[0, 3, 2] = 80.0
        output[0, 60, 2] = 0.91
        mock_session_for_model.return_value = FakeSession(output)

        detections = detect_cpu_objects(provider("yolo11s"), image_payload())

        self.assertEqual(len(detections), 2)
        self.assertEqual(detections[0]["label"], "person")
        self.assertEqual(detections[1]["label"], "chair")

    @patch("app.subsystems.live_video.cpu_detector._ensure_ort_compatible_model")
    @patch("app.subsystems.live_video.cpu_detector._load_session")
    def test_create_session_patches_model_when_onnxruntime_is_older(
        self,
        mock_load_session,
        mock_ensure_compatible_model,
    ) -> None:
        model_path = Path("/tmp/yolo11n.onnx")
        patched_path = Path("/tmp/yolo11n_opset21.onnx")
        mock_ensure_compatible_model.return_value = patched_path
        mock_load_session.side_effect = [
            Exception("Opset 22 is under development. Current official support for domain ai.onnx is till opset 21."),
            "patched-session",
        ]

        session = cpu_detector._create_session(model_path)

        self.assertEqual(session, "patched-session")
        mock_ensure_compatible_model.assert_called_once_with(model_path, 21)
        self.assertEqual(mock_load_session.call_count, 2)


if __name__ == "__main__":
    unittest.main()
