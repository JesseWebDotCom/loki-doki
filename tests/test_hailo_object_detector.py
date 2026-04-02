"""Tests for Hailo-backed object detection helpers."""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from app.providers.types import ProviderSpec
from app.subsystems.live_video.hailo_inference import HailoInferenceResult
from app.subsystems.live_video.hailo_object_detector import (
    _prepare_hailo_uint8_image,
    _run_infer_model_detection,
    detect_hailo_objects,
)


def provider(model: str = "yolo11s.hef") -> ProviderSpec:
    """Build an object-detector provider spec."""
    return ProviderSpec(
        name="object_detector",
        backend="hailort",
        model=model,
        acceleration="hailo",
    )


class HailoObjectDetectorTests(unittest.TestCase):
    """Verify Hailo object-detector output normalization."""

    @patch("app.subsystems.live_video.hailo_object_detector._detect_hailo_objects_with_infer_model")
    def test_detect_hailo_objects_uses_infer_model_for_packaged_h10_assets(self, mock_detect) -> None:
        mock_detect.return_value = [{"label": "person", "confidence": 0.9, "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}]

        detections = detect_hailo_objects(provider("yolov11m_h10.hef"), "ZmFrZQ==")

        mock_detect.assert_called_once()
        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["label"], "person")

    @patch("app.subsystems.live_video.hailo_object_detector.run_hailo_image_inference")
    def test_detect_hailo_objects_decodes_nms_outputs(self, mock_infer) -> None:
        mock_infer.return_value = HailoInferenceResult(
            input_name="images",
            input_shape=(640, 640, 3),
            input_order="NHWC",
            outputs={
                "__metadata__": {
                    "width": 100.0,
                    "height": 100.0,
                    "scale": 1.0,
                    "pad_x": 0.0,
                    "pad_y": 0.0,
                    "input_width": 100.0,
                    "input_height": 100.0,
                },
                "nms": [[np.asarray([[0.1, 0.2, 0.6, 0.7, 0.92]], dtype=np.float32)]],
            },
            output_orders={"nms": "HAILO_NMS_BY_CLASS"},
        )

        detections = detect_hailo_objects(provider(), "ZmFrZQ==")

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["label"], "person")
        self.assertAlmostEqual(detections[0]["x"], 0.2, places=3)
        self.assertAlmostEqual(detections[0]["width"], 0.5, places=3)

    @patch("app.subsystems.live_video.hailo_object_detector.run_hailo_image_inference")
    def test_detect_hailo_objects_decodes_raw_yolo_outputs(self, mock_infer) -> None:
        output = np.zeros((1, 84, 1), dtype=np.float32)
        output[0, 0, 0] = 320.0
        output[0, 1, 0] = 320.0
        output[0, 2, 0] = 160.0
        output[0, 3, 0] = 160.0
        output[0, 4, 0] = 0.91
        mock_infer.return_value = HailoInferenceResult(
            input_name="images",
            input_shape=(640, 640, 3),
            input_order="NHWC",
            outputs={
                "__metadata__": {
                    "width": 640.0,
                    "height": 640.0,
                    "scale": 1.0,
                    "pad_x": 0.0,
                    "pad_y": 0.0,
                    "input_width": 640.0,
                    "input_height": 640.0,
                },
                "raw": output,
            },
            output_orders={"raw": "NHWC"},
        )

        detections = detect_hailo_objects(provider(), "ZmFrZQ==")

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["label"], "person")

    def test_prepare_hailo_uint8_image_returns_writable_contiguous_tensor(self) -> None:
        image = Image.new("RGB", (320, 240), (255, 0, 0))

        tensor, _metadata = _prepare_hailo_uint8_image(image, (640, 640), "NHWC")

        self.assertTrue(tensor.flags["C_CONTIGUOUS"])
        self.assertTrue(tensor.flags["WRITEABLE"])

    @patch("app.subsystems.live_video.hailo_object_detector._decode_nms_outputs", return_value=[])
    @patch("app.subsystems.live_video.hailo_object_detector.shared_vdevice")
    def test_run_infer_model_detection_uses_infer_model_output_shape(
        self,
        mock_shared_vdevice,
        mock_decode_nms,
    ) -> None:
        image = Image.new("RGB", (320, 240), (255, 0, 0))
        output_buffer = np.empty((40080,), dtype=np.float32)

        mock_output_binding = MagicMock()
        mock_output_binding.get_buffer.return_value = output_buffer

        mock_bindings = MagicMock()
        mock_bindings.input.return_value = MagicMock()
        mock_bindings.output.return_value = mock_output_binding

        mock_configured = MagicMock()
        mock_configured.create_bindings.return_value = mock_bindings

        mock_output_spec = MagicMock()
        mock_output_spec.shape = [40080]
        mock_output_spec.format.order = "HAILO_NMS_BY_CLASS"
        mock_output_spec.format.type = "FLOAT32"

        mock_input_spec = MagicMock()
        mock_input_spec.shape = [640, 640, 3]
        mock_input_spec.format.order = "NHWC"

        mock_infer_model = MagicMock()
        mock_infer_model.input.return_value = mock_input_spec
        mock_infer_model.output_names = ["yolov11m/yolov8_nms_postprocess"]
        mock_infer_model.output.return_value = mock_output_spec
        mock_infer_model.configure.return_value = mock_configured

        mock_vdevice = MagicMock()
        mock_vdevice.create_infer_model.return_value = mock_infer_model
        mock_shared_vdevice.return_value.__enter__.return_value = mock_vdevice
        mock_shared_vdevice.return_value.__exit__.return_value = False

        with patch.dict(sys.modules, {"hailo_platform": types.SimpleNamespace(VDevice=object)}):
            _run_infer_model_detection("/tmp/yolov11m_h10.hef", image)

        output_array = mock_bindings.output.return_value.set_buffer.call_args.args[0]
        self.assertEqual(output_array.shape, (40080,))
        self.assertEqual(output_array.dtype, np.float32)
        mock_decode_nms.assert_called_once()
        decoded_output = mock_decode_nms.call_args.args[0][mock_infer_model.output_names[0]]
        self.assertTrue(decoded_output.flags["WRITEABLE"])


if __name__ == "__main__":
    unittest.main()
