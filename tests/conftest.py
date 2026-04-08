"""Cross-suite test fixtures.

Installs a deterministic fake embedder for every test so unit tests
never pay the cost (or the network round-trip) of loading the real
fastembed bge-small-en-v1.5 model. Tests that explicitly want the
real embedder can opt in by clearing the override:

    from lokidoki.core.embedder import set_embedder_for_testing
    set_embedder_for_testing(None)

The fake produces 384-dim vectors derived from a SHA-256 hash of the
input text — fully reproducible, fast, and gives identical strings
identical vectors so the search-ranking tests still mean something.
"""
from __future__ import annotations

import hashlib

import pytest

from lokidoki.core.embedder import EXPECTED_DIM, set_embedder_for_testing


class _DeterministicFakeEmbedder:
    def _vec(self, text: str) -> list[float]:
        h = hashlib.sha256(text.encode("utf-8")).digest()
        out: list[float] = []
        i = 0
        while len(out) < EXPECTED_DIM:
            out.append((h[i % len(h)] - 128) / 128.0)
            i += 1
        return out

    def embed_passages(self, texts):
        return [self._vec(t) for t in texts]

    def embed_query(self, text):
        return self._vec(text)


@pytest.fixture(autouse=True)
def _fake_embedder_for_all_tests():
    set_embedder_for_testing(_DeterministicFakeEmbedder())
    yield
    set_embedder_for_testing(None)
