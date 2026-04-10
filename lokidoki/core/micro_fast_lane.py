"""Embedding-based micro fast-lane for greetings and gratitude.

Fires BEFORE decomposition. If the user input is a trivial greeting or
gratitude turn with similarity >= 0.90 against a curated template set,
the orchestrator skips decomposition entirely and routes straight to
``social_ack``. Near-misses (similarity > 0.80) are logged for review
but fall through to the normal pipeline.

No emotional turns are bypassed — "I'm stressed out" or "hey I'm sad"
must go through the decomposer so sentiment is captured and the
humanization planner can react.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass
from typing import List, Optional

from lokidoki.core.embedder import Embedder, get_embedder

logger = logging.getLogger(__name__)

# Curated template strings. Each entry is a representative phrasing
# that should bypass the decomposer. The set is intentionally narrow —
# precision over recall.
GREETING_TEMPLATES: List[str] = [
    "hi",
    "hey",
    "hello",
    "good morning",
    "good afternoon",
    "good evening",
    "hey there",
    "hi there",
    "howdy",
    "what's up",
    "yo",
    "sup",
    "hiya",
]

GRATITUDE_TEMPLATES: List[str] = [
    "thanks",
    "thank you",
    "thanks a lot",
    "thank you so much",
    "thanks so much",
    "much appreciated",
    "appreciate it",
    "thx",
    "ty",
    "thanks!",
    "thank you!",
]

# Similarity thresholds.
FAST_LANE_THRESHOLD = 0.90
NEAR_MISS_THRESHOLD = 0.80

# Emotional markers that disqualify a turn from the fast-lane even if
# the greeting/gratitude similarity is high. These are checked via
# simple substring on the lowercased input — this is acceptable because
# we're filtering MACHINE-SCORED candidates, not classifying user
# intent (the embedder already did that).
_EMOTIONAL_DISQUALIFIERS = (
    "stress",
    "anxious",
    "depress",
    "sad ",
    "angry",
    "frustrat",
    "upset",
    "worried",
    "scared",
    "lonely",
    "hurting",
    "miserable",
    "overwhelm",
    "i feel",
    "i'm feeling",
    "im feeling",
    "not doing well",
    "not great",
    "not okay",
    "not ok",
    "having a hard",
    "bad day",
    "rough day",
    "tough day",
)


@dataclass
class FastLaneResult:
    """Result of the micro fast-lane check."""
    hit: bool
    category: str  # "greeting" | "gratitude" | ""
    best_similarity: float
    best_template: str
    latency_ms: float
    near_miss: bool  # True if > 0.80 but < 0.90


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _has_emotional_content(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in _EMOTIONAL_DISQUALIFIERS)


def _normalize_fast_lane_text(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


# Pre-computed template embeddings (lazy singleton).
_template_cache: Optional[dict[str, list[tuple[str, List[float]]]]] = None


def _get_template_embeddings(embedder: Embedder) -> dict[str, list[tuple[str, List[float]]]]:
    """Compute and cache template embeddings. Called once per process."""
    global _template_cache
    if _template_cache is not None:
        return _template_cache

    greeting_vecs = embedder.embed_passages(GREETING_TEMPLATES)
    gratitude_vecs = embedder.embed_passages(GRATITUDE_TEMPLATES)
    _template_cache = {
        "greeting": list(zip(GREETING_TEMPLATES, greeting_vecs)),
        "gratitude": list(zip(GRATITUDE_TEMPLATES, gratitude_vecs)),
    }
    return _template_cache


def reset_template_cache() -> None:
    """Clear cached template embeddings. Test-only."""
    global _template_cache
    _template_cache = None


def classify_fast_lane(user_input: str, embedder: Optional[Embedder] = None) -> FastLaneResult:
    """Check if user_input qualifies for the micro fast-lane.

    Sync function — callers in async contexts should use
    ``asyncio.to_thread`` or ``check_fast_lane``.
    """
    t0 = time.perf_counter()

    # Short-circuit: inputs longer than ~60 chars are unlikely to be
    # pure greetings/gratitude. Avoids embedding cost on long inputs.
    stripped = user_input.strip()
    if len(stripped) > 60:
        return FastLaneResult(
            hit=False, category="", best_similarity=0.0,
            best_template="", latency_ms=0.0, near_miss=False,
        )

    # Emotional content disqualifies regardless of similarity.
    if _has_emotional_content(stripped):
        return FastLaneResult(
            hit=False, category="", best_similarity=0.0,
            best_template="", latency_ms=0.0, near_miss=False,
        )

    normalized = _normalize_fast_lane_text(stripped)
    if normalized:
        for category, templates in (
            ("greeting", GREETING_TEMPLATES),
            ("gratitude", GRATITUDE_TEMPLATES),
        ):
            for template in templates:
                if normalized != _normalize_fast_lane_text(template):
                    continue
                latency_ms = (time.perf_counter() - t0) * 1000
                return FastLaneResult(
                    hit=True,
                    category=category,
                    best_similarity=1.0,
                    best_template=template,
                    latency_ms=latency_ms,
                    near_miss=False,
                )

    emb = embedder or get_embedder()
    templates = _get_template_embeddings(emb)
    query_vec = emb.embed_query(stripped)

    best_sim = 0.0
    best_tpl = ""
    best_cat = ""

    for category, pairs in templates.items():
        for tpl_text, tpl_vec in pairs:
            sim = _cosine_similarity(query_vec, tpl_vec)
            if sim > best_sim:
                best_sim = sim
                best_tpl = tpl_text
                best_cat = category

    latency_ms = (time.perf_counter() - t0) * 1000

    hit = best_sim >= FAST_LANE_THRESHOLD
    near_miss = not hit and best_sim > NEAR_MISS_THRESHOLD

    if near_miss:
        logger.info(
            "[micro_fast_lane] near-miss: input=%r best=%r sim=%.4f cat=%s",
            stripped[:40], best_tpl, best_sim, best_cat,
        )

    if hit:
        logger.info(
            "[micro_fast_lane] HIT: input=%r best=%r sim=%.4f cat=%s latency=%.1fms",
            stripped[:40], best_tpl, best_sim, best_cat, latency_ms,
        )

    return FastLaneResult(
        hit=hit,
        category=best_cat,
        best_similarity=best_sim,
        best_template=best_tpl,
        latency_ms=latency_ms,
        near_miss=near_miss,
    )


async def check_fast_lane(
    user_input: str, embedder: Optional[Embedder] = None,
) -> FastLaneResult:
    """Async wrapper — runs the sync classifier off the event loop."""
    return await asyncio.to_thread(classify_fast_lane, user_input, embedder)
