"""Tests for face-detection API routes."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())

from app import db, main
from app.classifier import Classification
from app.orchestrator import OrchestratedFaceDetectionResponse
from app.providers.types import ProviderSpec
from app.subsystems.live_video import BoundingBox, DetectedFace, FacePoint


def provider() -> ProviderSpec:
    """Build a provider spec for route tests."""
    return ProviderSpec(
        name="face_detector",
        backend="cpu_face_detector",
        model="scrfd_10g",
        acceleration="cpu",
    )


class FaceDetectionRouteTests(unittest.TestCase):
    """Verify face-detection routes return the shared schema."""

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
    @patch("app.main.route_face_detection")
    def test_detect_faces_api_returns_normalized_detection_payload(self, mock_route_face_detection, mock_runtime_context) -> None:
        mock_runtime_context.return_value = {"settings": {"profile": "mac"}, "providers": {"face_detector": provider()}}
        mock_route_face_detection.return_value = OrchestratedFaceDetectionResponse(
            classification=Classification(
                request_type="face_detection",
                route="face_detector",
                reason="Uploaded frame requested for face detection.",
            ),
            detections=(
                DetectedFace(
                    confidence=0.92,
                    bbox=BoundingBox(x=0.1, y=0.2, width=0.3, height=0.6),
                    landmarks=(FacePoint(x=0.2, y=0.3),),
                ),
            ),
            provider=provider(),
        )

        response = main.detect_faces_api(
            main.FaceDetectionRequest(image_data_url="data:image/png;base64,ZmFrZQ==", confidence_threshold=0.5),
            current_user=self.user,
        )

        self.assertEqual(response["count"], 1)
        self.assertEqual(len(response["detections"][0]["landmarks"]), 1)
        self.assertEqual(response["meta"]["execution"]["model"], "scrfd_10g")


if __name__ == "__main__":
    unittest.main()
