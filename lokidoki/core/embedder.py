"""Sentence embedder for fact-level semantic search.

Why this module exists
----------------------
``vec_facts`` (sqlite-vec) has been provisioned at 384 dims since PR3
but nothing has actually written embeddings into it. This module is the
write-side: a thin facade over the chosen embedding backend that the
``MemoryProvider`` calls on every fact insert and on every query.

Backend choice — fastembed + BAAI/bge-small-en-v1.5
---------------------------------------------------
- Native dimension is 384, matches the existing schema (no migration)
- ONNX runtime, no torch dependency, runs on Pi 5 ARM64
- ~30MB model + ~100MB onnxruntime — acceptable on the SD-card budget
- bge-small-en-v1.5 is the de facto standard small English embedder

The model file is downloaded once on first call and cached under the
fastembed default cache (``~/.cache/fastembed``). On a Pi we may want to
pre-place the model in ``data/models/`` later; the constructor accepts
a ``cache_dir`` override for that.

Singleton + lazy load
---------------------
Loading the model takes ~1-2s and ~150MB of RSS. We don't want every
test or every request paying that cost. ``get_embedder()`` returns a
process-singleton that loads on first call and is reused thereafter.
Tests that don't care about real vectors can install a fake via
``set_embedder_for_testing()``.

Sync, not async
---------------
fastembed is sync. Callers (``MemoryProvider``) are async and route
through ``asyncio.to_thread`` so the event loop never blocks on a
~50ms inference.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Iterable, List, Optional, Protocol

logger = logging.getLogger(__name__)

# Must match memory_schema.EMBEDDING_DIM. Asserted at load time so a
# mismatched model swap fails loudly instead of silently corrupting
# vec_facts.
EXPECTED_DIM = 384

# bge-small models prefer the query to be prefixed with this string at
# search time but NOT at indexing time. Asymmetric retrieval, per the
# bge model card. We do this in `embed_query` only.
_BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"


class Embedder(Protocol):
    """Minimal embedder interface so tests can swap a fake."""

    def embed_passages(self, texts: Iterable[str]) -> List[List[float]]: ...
    def embed_query(self, text: str) -> List[float]: ...


class FastEmbedEmbedder:
    """Production embedder using fastembed's TextEmbedding."""

    def __init__(self, model_name: str = DEFAULT_MODEL, cache_dir: Optional[str] = None):
        # Lazy import so test environments without fastembed installed
        # don't crash at import time when they only want the fake.
        from fastembed import TextEmbedding  # type: ignore

        self._model_name = model_name
        self._model = TextEmbedding(model_name=model_name, cache_dir=cache_dir)
        # Probe the dimension once so misconfigured swaps fail fast.
        probe = list(self._model.embed(["probe"]))
        actual = len(probe[0])
        if actual != EXPECTED_DIM:
            raise RuntimeError(
                f"embedder dim mismatch: model {model_name} produced "
                f"{actual}-dim vectors but vec_facts is {EXPECTED_DIM}-dim"
            )
        logger.info("[embedder] loaded %s (%d dims)", model_name, actual)

    def embed_passages(self, texts: Iterable[str]) -> List[List[float]]:
        """Embed N passages (facts, messages) for indexing.

        bge models do NOT prefix the document side — only the query.
        Returns a list of float lists (not numpy arrays) so callers can
        hand them straight to sqlite-vec without extra conversion.
        """
        out: list[list[float]] = []
        for vec in self._model.embed(list(texts)):
            out.append([float(x) for x in vec])
        return out

    def embed_query(self, text: str) -> List[float]:
        """Embed a single search query with the bge query prefix."""
        prefixed = _BGE_QUERY_PREFIX + text
        vec = next(iter(self._model.embed([prefixed])))
        return [float(x) for x in vec]


# ---- module-level singleton + test override --------------------------

_embedder_lock = threading.Lock()
_embedder_instance: Optional[Embedder] = None


def get_embedder() -> Embedder:
    """Return the process-singleton embedder, loading it on first call.

    The first call pays the model-load cost (~1-2s, ~150MB RSS).
    Subsequent calls are O(1). Thread-safe via a coarse module lock —
    contention is irrelevant because the slow path runs once.
    """
    global _embedder_instance
    if _embedder_instance is not None:
        return _embedder_instance
    with _embedder_lock:
        if _embedder_instance is not None:
            return _embedder_instance
        # ``LOKIDOKI_EMBED_CACHE`` lets ops point at a pre-downloaded
        # model on the Pi instead of fetching from HF on first boot.
        cache_dir = os.environ.get("LOKIDOKI_EMBED_CACHE")
        _embedder_instance = FastEmbedEmbedder(cache_dir=cache_dir)
        return _embedder_instance


def set_embedder_for_testing(fake: Optional[Embedder]) -> None:
    """Install a fake embedder (or clear with None). Test-only."""
    global _embedder_instance
    with _embedder_lock:
        _embedder_instance = fake
