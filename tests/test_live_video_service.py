"""Tests for Phase 6 object detection service."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.providers.types import ProviderSpec
from app.subsystems.live_video.service import ObjectDetectionError, detect_objects
from app.subsystems.text.client import ProviderRequestError


DATA_URL = "data:image/png;base64,ZmFrZV9pbWFnZQ=="


def provider(name: str, backend: str, model: str) -> ProviderSpec:
    """Build a provider spec for object-detection tests."""
    return ProviderSpec(
        name=name,
        backend=backend,
        model=model,
        acceleration="hailo" if backend == "hailort" else "cpu",
        fallback_backend="cpu_detector" if backend == "hailort" else None,
        fallback_model="yolo11n" if backend == "hailort" else None,
    )


class LiveVideoServiceTests(unittest.TestCase):
    """Verify object-detection provider routing and normalization."""

    @patch(
        "app.subsystems.live_video.service.request_cpu_detections",
        return_value=(
            {"label": "person", "confidence": 0.93, "x": 0.1, "y": 0.05, "width": 0.4, "height": 0.8},
            {"label": "lamp", "confidence": 0.14, "x": 0.7, "y": 0.2, "width": 0.2, "height": 0.5},
        ),
    )
    def test_detect_objects_normalizes_cpu_detections(self, _mock_detect) -> None:
        result = detect_objects(
            DATA_URL,
            "mac",
            {"object_detector": provider("object_detector", "cpu_detector", "yolo11s")},
            confidence_threshold=0.2,
        )

        self.assertEqual(result.provider.backend, "cpu_detector")
        self.assertEqual(len(result.detections), 1)
        self.assertEqual(result.detections[0].label, "person")
        self.assertEqual(result.detections[0].bbox.width, 0.4)

    @patch(
        "app.subsystems.live_video.service.request_cpu_detections",
        return_value=(
            {"label": "cat", "confidence": 0.81, "x": 0.2, "y": 0.2, "width": 0.3, "height": 0.3},
        ),
    )
    @patch(
        "app.subsystems.live_video.service.request_hailo_detections",
        side_effect=ProviderRequestError("device busy"),
    )
    def test_detect_objects_uses_cpu_fallback_when_hailo_request_fails(
        self,
        _mock_hailo,
        _mock_cpu,
    ) -> None:
        result = detect_objects(
            DATA_URL,
            "pi_hailo",
            {"object_detector": provider("object_detector", "hailort", "yolo11s.hef")},
            confidence_threshold=0.2,
        )

        self.assertEqual(result.provider.name, "object_detector_fallback")
        self.assertEqual(result.provider.backend, "cpu_detector")
        self.assertEqual(result.detections[0].label, "cat")

    def test_invalid_data_url_raises_object_detection_error(self) -> None:
        with self.assertRaises(ObjectDetectionError):
            detect_objects(
                "not-a-data-url",
                "mac",
                {"object_detector": provider("object_detector", "cpu_detector", "yolo11s")},
            )


if __name__ == "__main__":
    unittest.main()
