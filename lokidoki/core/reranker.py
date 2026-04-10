"""Phase 7: optional cross-encoder reranker for fact retrieval.

When the reranker_v1 experiment arm is "reranker", this module
reranks the top-N RRF candidates using a cross-encoder model
(BAAI/bge-reranker-base) to improve precision. The reranker scores
(query, passage) pairs directly, which is more accurate than
embedding similarity but slower — hence it's behind an experiment
flag.

The reranker is optional: if the model isn't installed or fails to
load, the pipeline falls back to the baseline RRF ranking silently.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional, Protocol

logger = logging.getLogger(__name__)

DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-base"


class Reranker(Protocol):
    """Minimal reranker interface so tests can swap a fake."""

    def rerank(
        self, query: str, passages: list[str], top_k: int = 5
    ) -> list[tuple[int, float]]:
        """Return (original_index, score) pairs sorted by relevance."""
        ...


class CrossEncoderReranker:
    """Production reranker using fastembed or sentence-transformers."""

    def __init__(self, model_name: str = DEFAULT_RERANKER_MODEL):
        self._model_name = model_name
        self._model = None
        self._load_model()

    def _load_model(self) -> None:
        try:
            from fastembed import TextCrossEncoder  # type: ignore

            self._model = TextCrossEncoder(model_name=self._model_name)
            logger.info("[reranker] loaded %s via fastembed", self._model_name)
        except ImportError:
            logger.warning(
                "[reranker] fastembed TextCrossEncoder not available; "
                "reranker experiment will fall back to baseline"
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "[reranker] failed to load %s; falling back",
                self._model_name,
                exc_info=True,
            )

    def rerank(
        self, query: str, passages: list[str], top_k: int = 5
    ) -> list[tuple[int, float]]:
        if self._model is None or not passages:
            return [(i, 0.0) for i in range(min(top_k, len(passages)))]
        pairs = [(query, p) for p in passages]
        scores = list(self._model.rerank(query, passages))
        indexed = [(i, float(s)) for i, s in enumerate(scores)]
        indexed.sort(key=lambda x: x[1], reverse=True)
        return indexed[:top_k]


# ---- module-level singleton + test override --------------------------

_reranker_lock = threading.Lock()
_reranker_instance: Optional[Reranker] = None
_reranker_disabled = False


def get_reranker() -> Optional[Reranker]:
    """Return the process-singleton reranker, or None if unavailable."""
    global _reranker_instance, _reranker_disabled
    if _reranker_disabled:
        return None
    if _reranker_instance is not None:
        return _reranker_instance
    with _reranker_lock:
        if _reranker_instance is not None:
            return _reranker_instance
        if _reranker_disabled:
            return None
        try:
            _reranker_instance = CrossEncoderReranker()
        except Exception:  # noqa: BLE001
            logger.warning("[reranker] init failed; disabling for this process")
            _reranker_disabled = True
            return None
        return _reranker_instance


def set_reranker_for_testing(fake: Optional[Reranker]) -> None:
    """Install a fake reranker (or clear with None). Test-only."""
    global _reranker_instance, _reranker_disabled
    with _reranker_lock:
        _reranker_instance = fake
        _reranker_disabled = fake is None


def rerank_facts(
    query: str,
    facts: list[dict],
    *,
    top_k: int = 5,
) -> list[dict]:
    """Rerank fact dicts using the cross-encoder.

    Returns facts sorted by reranker score. Falls back to the
    original ordering if the reranker is unavailable.
    """
    reranker = get_reranker()
    if reranker is None or not facts:
        return facts[:top_k]

    passages = [
        f"{f.get('subject', '')} {f.get('predicate', '')} {f.get('value', '')}".strip()
        for f in facts
    ]

    t0 = time.perf_counter()
    try:
        ranked = reranker.rerank(query, passages, top_k=top_k)
    except Exception:  # noqa: BLE001
        logger.warning("[reranker] rerank failed; returning original order")
        return facts[:top_k]
    elapsed_ms = (time.perf_counter() - t0) * 1000
    logger.info("[reranker] reranked %d facts in %.1fms", len(facts), elapsed_ms)

    return [facts[idx] for idx, _ in ranked if idx < len(facts)]
