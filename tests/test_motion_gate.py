"""Tests for the live-video motion gate."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from app.subsystems.live_video import motion_gate


class MotionGateTests(unittest.TestCase):
    """Verify motion-gate inference skipping behavior."""

    def setUp(self) -> None:
        motion_gate._STATE.clear()

    def test_motion_gate_runs_detection_when_opencv_is_unavailable(self) -> None:
        calls: list[str] = []

        with patch("app.subsystems.live_video.motion_gate._cv2_module", return_value=None):
            result = motion_gate.detect_with_motion_gate(
                "mac:face_detector",
                "ZmFrZQ==",
                lambda: calls.append("ran") or ({"confidence": 0.9},),
            )

        self.assertEqual(calls, ["ran"])
        self.assertEqual(result, ({"confidence": 0.9},))

    def test_motion_gate_returns_last_result_when_frame_is_still(self) -> None:
        class FakeSubtractor:
            def __init__(self) -> None:
                self.calls = 0

            def apply(self, _frame):
                self.calls += 1
                return (
                    np.asarray([[255, 255], [255, 255]], dtype=np.uint8)
                    if self.calls == 1
                    else np.asarray([[0, 0], [0, 0]], dtype=np.uint8)
                )

        class FakeCv2:
            @staticmethod
            def createBackgroundSubtractorMOG2(**_kwargs):
                return FakeSubtractor()

            @staticmethod
            def countNonZero(mask):
                return sum(1 for row in mask for value in row if value)

        calls: list[str] = []

        with patch("app.subsystems.live_video.motion_gate._cv2_module", return_value=FakeCv2()):
            with patch(
                "app.subsystems.live_video.motion_gate._decode_frame",
                return_value=np.asarray([[0, 0], [0, 0]], dtype=np.uint8),
            ):
                first = motion_gate.detect_with_motion_gate(
                    "mac:object_detector",
                    "ZmFrZQ==",
                    lambda: calls.append("ran") or ({"label": "person"},),
                )
                second = motion_gate.detect_with_motion_gate(
                    "mac:object_detector",
                    "ZmFrZQ==",
                    lambda: calls.append("ran-again") or ({"label": "cat"},),
                )

        self.assertEqual(calls, ["ran"])
        self.assertEqual(first, ({"label": "person"},))
        self.assertEqual(second, ({"label": "person"},))


if __name__ == "__main__":
    unittest.main()
