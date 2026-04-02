"""Tests for Phase 7 face detection service."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.providers.types import ProviderSpec
from app.subsystems.live_video.face_service import FaceDetectionError, detect_faces
from app.subsystems.live_video.face_cpu_detector import _input_size
from app.subsystems.text.client import ProviderRequestError


DATA_URL = "data:image/png;base64,ZmFrZV9pbWFnZQ=="


def provider(name: str, backend: str, model: str) -> ProviderSpec:
    """Build a provider spec for face-detection tests."""
    return ProviderSpec(
        name=name,
        backend=backend,
        model=model,
        acceleration="hailo" if backend == "hailort" else "cpu",
        fallback_backend="cpu_face_detector" if backend == "hailort" else None,
        fallback_model="scrfd_500m" if backend == "hailort" else None,
    )


class FaceDetectionServiceTests(unittest.TestCase):
    """Verify face-detection provider routing and normalization."""

    @patch(
        "app.subsystems.live_video.face_service.request_onnx_face_detections",
        return_value=(
            {
                "confidence": 0.93,
                "x": 0.1,
                "y": 0.05,
                "width": 0.3,
                "height": 0.4,
                "landmarks": [{"x": 0.15, "y": 0.2}],
            },
            {"confidence": 0.14, "x": 0.7, "y": 0.2, "width": 0.2, "height": 0.3, "landmarks": []},
        ),
    )
    @patch(
        "app.subsystems.live_video.face_service.recognize_faces",
        side_effect=lambda _image_base64, detections, _profile: detections,
    )
    def test_detect_faces_normalizes_cpu_detections(self, _mock_recognize, _mock_detect) -> None:
        result = detect_faces(
            DATA_URL,
            "mac",
            {"face_detector": provider("face_detector", "onnx_face_detector", "yolov5s_personface.onnx")},
            confidence_threshold=0.5,
        )

        self.assertEqual(result.provider.backend, "onnx_face_detector")
        self.assertEqual(len(result.detections), 1)
        self.assertEqual(result.detections[0].bbox.width, 0.3)
        self.assertEqual(len(result.detections[0].landmarks), 1)

    @patch(
        "app.subsystems.live_video.face_service.recognize_faces",
        return_value=(),
    )
    @patch(
        "app.subsystems.live_video.face_service.request_onnx_face_detections",
        return_value=(
            {"confidence": 0.93, "x": 0.1, "y": 0.05, "width": 0.3, "height": 0.4, "landmarks": []},
        ),
    )
    def test_detect_faces_routes_through_recognition_layer(self, _mock_detect, mock_recognize) -> None:
        detect_faces(
            DATA_URL,
            "mac",
            {"face_detector": provider("face_detector", "onnx_face_detector", "yolov5s_personface.onnx")},
            confidence_threshold=0.5,
        )

        self.assertTrue(mock_recognize.called)

    @patch(
        "app.subsystems.live_video.face_service.request_cpu_face_detections",
        return_value=(
            {"confidence": 0.81, "x": 0.2, "y": 0.2, "width": 0.3, "height": 0.3, "landmarks": []},
        ),
    )
    @patch(
        "app.subsystems.live_video.face_service.request_hailo_face_detections",
        side_effect=ProviderRequestError("device busy"),
    )
    @patch(
        "app.subsystems.live_video.face_service.recognize_faces",
        side_effect=lambda _image_base64, detections, _profile: detections,
    )
    def test_detect_faces_uses_cpu_fallback_when_hailo_request_fails(self, _mock_recognize, _mock_hailo, _mock_cpu) -> None:
        result = detect_faces(
            DATA_URL,
            "pi_hailo",
            {"face_detector": provider("face_detector", "hailort", "yolov5s_personface.hef")},
            confidence_threshold=0.5,
        )

        self.assertEqual(result.provider.name, "face_detector_fallback")
        self.assertEqual(result.provider.backend, "cpu_face_detector")

    def test_invalid_data_url_raises_face_detection_error(self) -> None:
        with self.assertRaises(FaceDetectionError):
            detect_faces("not-a-data-url", "mac", {"face_detector": provider("face_detector", "onnx_face_detector", "yolov5s_personface.onnx")})

    def test_input_size_falls_back_for_dynamic_onnx_shapes(self) -> None:
        session = SimpleNamespace(
            get_inputs=lambda: [SimpleNamespace(shape=[1, 3, "?", "?"])],
        )

        self.assertEqual(_input_size(session, "scrfd_10g"), (640, 640))

    @patch(
        "app.subsystems.live_video.face_service.request_onnx_face_detections",
        return_value=(
            {"confidence": 0.88, "x": 0.2, "y": 0.2, "width": 0.2, "height": 0.2, "landmarks": []},
        ),
    )
    @patch(
        "app.subsystems.live_video.face_service.recognize_faces",
        side_effect=lambda _image_base64, detections, _profile: detections,
    )
    @patch(
        "app.subsystems.live_video.face_service.detect_with_motion_gate",
        side_effect=AssertionError("motion gate should be bypassed"),
    )
    def test_detect_faces_can_bypass_motion_gate(self, _mock_gate, _mock_recognize, _mock_detect) -> None:
        result = detect_faces(
            DATA_URL,
            "mac",
            {"face_detector": provider("face_detector", "onnx_face_detector", "yolov5s_personface.onnx")},
            confidence_threshold=0.5,
            use_motion_gate=False,
        )

        self.assertEqual(len(result.detections), 1)


if __name__ == "__main__":
    unittest.main()
