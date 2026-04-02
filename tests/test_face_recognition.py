"""Tests for face registration merge behavior."""

from __future__ import annotations

import unittest

from app.subsystems.live_video.face_recognition import _merge_registered_face, registration_is_complete
from app.subsystems.live_video.face_registry import RegisteredFace


class FaceRecognitionTests(unittest.TestCase):
    """Verify registration merge helpers."""

    def test_merge_registered_face_accumulates_modes_and_sample_counts(self) -> None:
        existing = RegisteredFace(name="Jesse", vector=(1.0, 0.0), sample_count=10, modes=("close_up",))
        fresh = RegisteredFace(name="Jesse", vector=(0.0, 1.0), sample_count=15, modes=("far",))

        merged = _merge_registered_face(existing, fresh)

        self.assertEqual(merged.sample_count, 25)
        self.assertEqual(merged.modes, ("close_up", "far"))

    def test_registration_is_complete_requires_close_up_and_far(self) -> None:
        self.assertFalse(registration_is_complete(RegisteredFace(name="Jesse", vector=(1.0, 0.0), modes=("close_up",))))
        self.assertTrue(registration_is_complete(RegisteredFace(name="Jesse", vector=(1.0, 0.0), modes=("close_up", "far"))))


if __name__ == "__main__":
    unittest.main()
