"""Embedding helpers for v2 semantic routing."""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from hashlib import blake2b

try:
    from fastembed import TextEmbedding
except ImportError:  # pragma: no cover - dependency is optional in tests
    TextEmbedding = None


TOKEN_RE = re.compile(r"[A-Za-z0-9']+")
HASH_DIMENSIONS = 64
FASTEMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


@dataclass(slots=True)
class EmbeddingBackend:
    name: str
    dimensions: int

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError


class FastEmbedBackend(EmbeddingBackend):
    """MiniLM embeddings via fastembed when the model is available."""

    def __init__(self, model_name: str = FASTEMBED_MODEL) -> None:
        self._model = TextEmbedding(model_name=model_name)
        probe = list(self._model.embed(["probe"]))[0]
        super().__init__(name=f"fastembed:{model_name}", dimensions=len(probe))

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return [vector.tolist() for vector in self._model.embed(texts)]


class HashEmbeddingBackend(EmbeddingBackend):
    """Deterministic local fallback used when MiniLM is unavailable."""

    def __init__(self) -> None:
        super().__init__(name="hash-fallback", dimensions=HASH_DIMENSIONS)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [_hash_embed_text(text, self.dimensions) for text in texts]


@lru_cache(maxsize=1)
def get_embedding_backend() -> EmbeddingBackend:
    """Return the preferred embedding backend with graceful fallback."""
    if TextEmbedding is not None:
        try:
            return FastEmbedBackend()
        except Exception:
            pass
    return HashEmbeddingBackend()


def _hash_embed_text(text: str, dimensions: int) -> list[float]:
    tokens = TOKEN_RE.findall(text.lower())
    if not tokens:
        return [0.0] * dimensions
    counts = Counter(tokens)
    vector = [0.0] * dimensions
    for token, count in counts.items():
        digest = blake2b(token.encode("utf-8"), digest_size=8).digest()
        slot = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[slot] += count * sign
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return vector
    return [round(value / norm, 6) for value in vector]
