"""Tests for person-registration API routes."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())

from app import db, main


class FaceRegistrationRouteTests(unittest.TestCase):
    """Verify person-registration endpoints return the expected payloads."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.bootstrap_config_path = Path(self._temp_dir.name) / "bootstrap_config.json"
        self.app_config = replace(
            main.APP_CONFIG,
            database_path=self.database_path,
            bootstrap_config_path=self.bootstrap_config_path,
        )
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._config_patch = patch.object(main, "APP_CONFIG", self.app_config)
        self._config_patch.start()
        with main.connection_scope() as connection:
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed-password")

    def tearDown(self) -> None:
        self._config_patch.stop()
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._temp_dir.cleanup()

    @patch("app.main.runtime_context")
    @patch("app.main.analyze_registration_frame")
    def test_frame_analysis_route_returns_quality_payload(self, mock_analyze, mock_runtime_context) -> None:
        mock_runtime_context.return_value = {"settings": {"profile": "pi_hailo"}, "providers": {}}
        mock_analyze.return_value = type(
            "Analysis",
            (),
            {
                "accepted": True,
                "guidance": "Perfect, hold that.",
                "target_count": 10,
                "face": type("Face", (), {"to_dict": lambda self: {"confidence": 0.91}})(),
                "quality": type("Quality", (), {"to_dict": lambda self: {"sharpness": 72.0}})(),
            },
        )()

        response = main.analyze_face_registration_frame_api(
            main.FaceRegistrationFrameRequest(image_data_url="data:image/png;base64,ZmFrZQ==", mode="close_up"),
            current_user=self.user,
        )

        self.assertTrue(response["accepted"])
        self.assertEqual(response["target_count"], 10)
        self.assertEqual(response["face"]["confidence"], 0.91)

    @patch("app.subsystems.live_video.face_recognition._decode_image")
    @patch("app.subsystems.live_video.face_recognition.measure_face_quality")
    @patch("app.subsystems.live_video.face_service.detect_faces")
    def test_analyze_registration_frame_uses_lower_face_threshold_and_bypasses_motion_gate(
        self,
        mock_detect_faces,
        mock_measure_quality,
        mock_decode_image,
    ) -> None:
        from app.subsystems.live_video.face_recognition import (
            REGISTRATION_FACE_CONFIDENCE_THRESHOLD,
            FaceQuality,
            analyze_registration_frame,
        )
        from app.subsystems.live_video.face_service import DetectedFace
        from app.subsystems.live_video.service import BoundingBox
        from PIL import Image

        detected_face = DetectedFace(
            confidence=0.31,
            bbox=BoundingBox(x=0.1, y=0.1, width=0.4, height=0.4),
            landmarks=(),
        )
        provider_map = {"face_detector": object()}
        mock_detect_faces.return_value = type("Result", (), {"detections": (detected_face,)})()
        mock_measure_quality.return_value = FaceQuality(width_px=140, height_px=140, sharpness=99.0, yaw=0.0, pitch=0.0)
        mock_decode_image.return_value = Image.new("RGB", (320, 240))

        analysis = analyze_registration_frame(
            "data:image/png;base64,ZmFrZQ==",
            "mac",
            provider_map,
            "close_up",
        )

        self.assertTrue(analysis.accepted)
        mock_detect_faces.assert_called_once_with(
            "data:image/png;base64,ZmFrZQ==",
            "mac",
            provider_map,
            confidence_threshold=REGISTRATION_FACE_CONFIDENCE_THRESHOLD,
            use_motion_gate=False,
        )

    @patch("app.main.runtime_context")
    @patch("app.main.register_person")
    @patch("app.main.list_registered_people", return_value=("Sarah",))
    def test_register_person_route_returns_saved_name(
        self,
        _mock_people,
        mock_register_person,
        mock_runtime_context,
    ) -> None:
        mock_runtime_context.return_value = {"settings": {"profile": "mac"}, "providers": {}}
        mock_register_person.return_value = type("Record", (), {"name": "Sarah", "sample_count": 10, "modes": ("close_up", "far")})()

        response = main.register_person_api(
            main.FaceRegistrationRequest(name="Sarah", mode="close_up", frames=["data:image/png;base64,ZmFrZQ=="]),
            current_user=self.user,
        )

        self.assertEqual(response["person"]["name"], "Sarah")
        self.assertEqual(response["person"]["sample_count"], 10)
        self.assertEqual(response["person"]["modes"], ["close_up", "far"])
        self.assertTrue(response["person"]["is_complete"])
        self.assertEqual(response["count"], 1)

    @patch(
        "app.main.list_registered_face_records",
        return_value=(
            type("Record", (), {"name": "Sarah", "sample_count": 25, "modes": ("close_up", "far")})(),
            type("Record", (), {"name": "Finn", "sample_count": 10, "modes": ("close_up",)})(),
        ),
    )
    def test_list_registered_people_route_returns_names(self, _mock_people) -> None:
        response = main.list_registered_people_api(current_user=self.user)

        self.assertEqual(response["people"][0]["name"], "Sarah")
        self.assertEqual(response["people"][1]["name"], "Finn")
        self.assertTrue(response["people"][0]["is_complete"])
        self.assertFalse(response["people"][1]["is_complete"])

    @patch("app.main.delete_registered_person", return_value=True)
    def test_delete_registered_person_route_returns_removed_flag(self, _mock_delete) -> None:
        response = main.delete_registered_person_api("Sarah", current_user=self.user)

        self.assertTrue(response["removed"])


if __name__ == "__main__":
    unittest.main()
