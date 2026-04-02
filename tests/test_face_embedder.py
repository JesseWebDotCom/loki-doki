"""Tests for face embedding helpers."""

from __future__ import annotations

import math
import unittest

from app.subsystems.live_video.face_embedder import cosine_similarity, merge_embeddings


class FaceEmbedderTests(unittest.TestCase):
    """Verify embedding math helpers."""

    def test_cosine_similarity_supports_python39_zip(self) -> None:
        score = cosine_similarity((1.0, 0.0), (0.5, 0.5))

        self.assertAlmostEqual(score, 0.5)

    def test_merge_embeddings_weights_existing_and_new_samples(self) -> None:
        merged = merge_embeddings((1.0, 0.0), 10, (0.0, 1.0), 5)

        self.assertTrue(math.isclose(math.sqrt(sum(value * value for value in merged)), 1.0, rel_tol=1e-6))
        self.assertGreater(merged[0], merged[1])


if __name__ == "__main__":
    unittest.main()
