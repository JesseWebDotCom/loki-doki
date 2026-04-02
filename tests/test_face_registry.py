"""Tests for flat-file face registry helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.subsystems.live_video.face_registry import (
    RegisteredFace,
    load_registered_faces,
    remove_registered_face,
    upsert_registered_face,
)


class FaceRegistryTests(unittest.TestCase):
    """Verify registered identities persist outside the database."""

    def test_upsert_and_remove_registered_face(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "faces.json"

            upsert_registered_face(RegisteredFace(name="Sarah", vector=(0.1, 0.2, 0.3)), path)
            upsert_registered_face(RegisteredFace(name="Finn", vector=(0.4, 0.5, 0.6)), path)

            saved = load_registered_faces(path)

            self.assertEqual([face.name for face in saved], ["Finn", "Sarah"])
            self.assertTrue(remove_registered_face("Sarah", path))
            self.assertEqual([face.name for face in load_registered_faces(path)], ["Finn"])

    def test_registry_preserves_sample_count_and_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "faces.json"

            upsert_registered_face(
                RegisteredFace(name="Sarah", vector=(0.1, 0.2, 0.3), sample_count=12, modes=("close_up", "far")),
                path,
            )

            saved = load_registered_faces(path)

            self.assertEqual(saved[0].sample_count, 12)
            self.assertEqual(saved[0].modes, ("close_up", "far"))


if __name__ == "__main__":
    unittest.main()
