"""Tests for Hailo-backed face detection helpers."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from app.providers.types import ProviderSpec
from app.subsystems.live_video.hailo_face_detector import detect_hailo_faces
from app.subsystems.live_video.hailo_inference import HailoInferenceResult
from app.subsystems.live_video.personface_decoder import decode_personface_raw_outputs


def provider(model: str = "yolov5s_personface.hef") -> ProviderSpec:
    """Build a face-detector provider spec."""
    return ProviderSpec(
        name="face_detector",
        backend="hailort",
        model=model,
        acceleration="hailo",
    )


class HailoFaceDetectorTests(unittest.TestCase):
    """Verify Hailo face-detector output normalization."""

    @patch("app.subsystems.live_video.hailo_face_detector.run_hailo_image_inference")
    def test_detect_hailo_faces_decodes_nms_outputs(self, mock_infer) -> None:
        mock_infer.return_value = HailoInferenceResult(
            input_name="images",
            input_shape=(640, 640, 3),
            input_order="NHWC",
            outputs={
                "__metadata__": {
                    "width": 200.0,
                    "height": 100.0,
                    "scale": 1.0,
                    "input_size": (200, 100),
                },
                "nms": [[
                    np.asarray([[0.0, 0.0, 0.5, 0.5, 0.33]], dtype=np.float32),
                    np.asarray([[0.1, 0.2, 0.8, 0.7, 0.95]], dtype=np.float32),
                ]],
            },
            output_orders={"nms": "HAILO_NMS_BY_CLASS"},
        )

        detections = detect_hailo_faces(provider(), "ZmFrZQ==")

        self.assertEqual(len(detections), 1)
        self.assertAlmostEqual(detections[0]["x"], 0.2, places=3)
        self.assertAlmostEqual(detections[0]["height"], 0.7, places=3)

    @patch("app.subsystems.live_video.hailo_face_detector.run_hailo_image_inference")
    def test_detect_hailo_faces_decodes_nested_nms_face_bucket_rows(self, mock_infer) -> None:
        mock_infer.return_value = HailoInferenceResult(
            input_name="images",
            input_shape=(640, 640, 3),
            input_order="NHWC",
            outputs={
                "__metadata__": {
                    "width": 200.0,
                    "height": 100.0,
                    "scale": 1.0,
                    "input_size": (200, 100),
                },
                "nms": [[
                    [[0.0, 0.0, 0.5, 0.5, 0.33]],
                    [[[0.1, 0.2, 0.8, 0.7, 0.95]]],
                ]],
            },
            output_orders={"nms": "HAILO_NMS_BY_CLASS"},
        )

        detections = detect_hailo_faces(provider(), "ZmFrZQ==")

        self.assertEqual(len(detections), 1)
        self.assertAlmostEqual(detections[0]["confidence"], 0.95, places=3)

    @patch("app.subsystems.live_video.hailo_face_detector.run_hailo_image_inference")
    def test_detect_hailo_faces_decodes_scrfd_style_outputs(self, mock_infer) -> None:
        scores = np.zeros((12800,), dtype=np.float32)
        bbox = np.zeros((12800, 4), dtype=np.float32)
        kps = np.zeros((12800, 10), dtype=np.float32)
        scores[0] = 0.9
        bbox[0] = [4.0, 4.0, 4.0, 4.0]
        kps[0] = [0.0] * 10
        zeros_3200 = np.zeros((3200,), dtype=np.float32)
        zeros_3200_bbox = np.zeros((3200, 4), dtype=np.float32)
        zeros_3200_kps = np.zeros((3200, 10), dtype=np.float32)
        zeros_800 = np.zeros((800,), dtype=np.float32)
        zeros_800_bbox = np.zeros((800, 4), dtype=np.float32)
        zeros_800_kps = np.zeros((800, 10), dtype=np.float32)
        mock_infer.return_value = HailoInferenceResult(
            input_name="images",
            input_shape=(640, 640, 3),
            input_order="NHWC",
            outputs={
                "__metadata__": {
                    "width": 640.0,
                    "height": 640.0,
                    "scale": 1.0,
                    "input_size": (640, 640),
                },
                "scores8": scores[None, :],
                "scores16": zeros_3200[None, :],
                "scores32": zeros_800[None, :],
                "bbox8": bbox[None, :, :],
                "bbox16": zeros_3200_bbox[None, :, :],
                "bbox32": zeros_800_bbox[None, :, :],
                "kps8": kps[None, :, :],
                "kps16": zeros_3200_kps[None, :, :],
                "kps32": zeros_800_kps[None, :, :],
            },
            output_orders={
                "scores8": "NHWC",
                "scores16": "NHWC",
                "scores32": "NHWC",
                "bbox8": "NHWC",
                "bbox16": "NHWC",
                "bbox32": "NHWC",
                "kps8": "NHWC",
                "kps16": "NHWC",
                "kps32": "NHWC",
            },
        )

        detections = detect_hailo_faces(provider(), "ZmFrZQ==")

        self.assertEqual(len(detections), 1)
        self.assertGreaterEqual(len(detections[0]["landmarks"]), 5)

    def test_decode_personface_raw_outputs_returns_no_faces_for_blank_logits(self) -> None:
        outputs = [
            np.full((1, 3, 80, 80, 7), -12.0, dtype=np.float32),
            np.full((1, 3, 40, 40, 7), -12.0, dtype=np.float32),
            np.full((1, 3, 20, 20, 7), -12.0, dtype=np.float32),
        ]

        detections = decode_personface_raw_outputs(
            outputs,
            {"width": 640.0, "height": 480.0, "scale": 1.0, "input_size": (640, 640)},
        )

        self.assertEqual(detections, [])

    def test_decode_personface_raw_outputs_keeps_one_face_candidate(self) -> None:
        outputs = [
            np.full((1, 3, 80, 80, 7), -12.0, dtype=np.float32),
            np.full((1, 3, 40, 40, 7), -12.0, dtype=np.float32),
            np.full((1, 3, 20, 20, 7), -12.0, dtype=np.float32),
        ]
        outputs[0][0, 1, 20, 30, 0] = 0.2
        outputs[0][0, 1, 20, 30, 1] = -0.1
        outputs[0][0, 1, 20, 30, 2] = 0.0
        outputs[0][0, 1, 20, 30, 3] = 0.0
        outputs[0][0, 1, 20, 30, 4] = 8.0
        outputs[0][0, 1, 20, 30, 5] = -8.0
        outputs[0][0, 1, 20, 30, 6] = 8.0

        detections = decode_personface_raw_outputs(
            outputs,
            {"width": 640.0, "height": 480.0, "scale": 1.0, "input_size": (640, 640)},
        )

        self.assertEqual(len(detections), 1)
        self.assertGreater(detections[0]["confidence"], 0.9)


if __name__ == "__main__":
    unittest.main()
