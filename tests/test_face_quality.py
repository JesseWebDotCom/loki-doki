"""Tests for face-quality helpers."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from app.subsystems.live_video.face_quality import _laplacian_variance, _laplacian_variance_without_cv2


REAL_IMPORT = __import__


class FaceQualityTests(unittest.TestCase):
    """Verify registration quality checks stay available without OpenCV."""

    def test_laplacian_variance_without_cv2_fallback_returns_numeric_score(self) -> None:
        image = Image.fromarray(np.array([[0, 255], [255, 0]], dtype=np.uint8), mode="L")

        with patch("builtins.__import__", side_effect=_import_without_cv2):
            score = _laplacian_variance(image)

        self.assertGreaterEqual(score, 0.0)

    def test_laplacian_variance_without_cv2_matches_direct_helper_shape(self) -> None:
        gray = np.array([[0.0, 255.0], [255.0, 0.0]], dtype=np.float64)

        score = _laplacian_variance_without_cv2(gray, np)

        self.assertGreaterEqual(score, 0.0)


def _import_without_cv2(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "cv2":
        raise ImportError("cv2 unavailable")
    return REAL_IMPORT(name, globals, locals, fromlist, level)


if __name__ == "__main__":
    unittest.main()
