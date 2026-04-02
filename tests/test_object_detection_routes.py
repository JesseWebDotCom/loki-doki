"""Tests for object-detection API routes."""

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
from app.orchestrator import OrchestratedObjectDetectionResponse
from app.providers.types import ProviderSpec
from app.subsystems.live_video import BoundingBox, DetectedObject


def provider() -> ProviderSpec:
    """Build a provider spec for route tests."""
    return ProviderSpec(
        name="object_detector",
        backend="cpu_detector",
        model="yolo11s",
        acceleration="cpu",
    )


class ObjectDetectionRouteTests(unittest.TestCase):
    """Verify object-detection routes return the shared schema."""

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
    @patch("app.main.route_object_detection")
    def test_detect_objects_api_returns_normalized_detection_payload(
        self,
        mock_route_object_detection,
        mock_runtime_context,
    ) -> None:
        mock_runtime_context.return_value = {
            "settings": {"profile": "mac"},
            "providers": {"object_detector": provider()},
        }
        mock_route_object_detection.return_value = OrchestratedObjectDetectionResponse(
            classification=Classification(
                request_type="object_detection",
                route="object_detector",
                reason="Uploaded frame requested for object detection.",
            ),
            detections=(
                DetectedObject(
                    label="person",
                    confidence=0.92,
                    bbox=BoundingBox(x=0.1, y=0.2, width=0.3, height=0.6),
                ),
            ),
            provider=provider(),
        )

        response = main.detect_objects_api(
            main.ObjectDetectionRequest(
                image_data_url="data:image/png;base64,ZmFrZQ==",
                confidence_threshold=0.25,
            ),
            current_user=self.user,
        )

        self.assertEqual(response["count"], 1)
        self.assertEqual(response["detections"][0]["label"], "person")
        self.assertEqual(response["meta"]["execution"]["model"], "yolo11s")
        mock_route_object_detection.assert_called_once_with(
            "data:image/png;base64,ZmFrZQ==",
            "mac",
            {"object_detector": provider()},
            0.25,
        )


if __name__ == "__main__":
    unittest.main()
