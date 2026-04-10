"""Unit tests for the Phase 5 micro fast-lane classifier."""
from __future__ import annotations

import math
from typing import Iterable, List

import pytest

from lokidoki.core.micro_fast_lane import (
    FAST_LANE_THRESHOLD,
    NEAR_MISS_THRESHOLD,
    FastLaneResult,
    _normalize_fast_lane_text,
    classify_fast_lane,
    reset_template_cache,
    _cosine_similarity,
    _has_emotional_content,
)


# -- cosine similarity math --------------------------------------------------

def test_cosine_identical_vectors():
    v = [1.0, 2.0, 3.0]
    assert _cosine_similarity(v, v) == pytest.approx(1.0)


def test_cosine_orthogonal_vectors():
    a = [1.0, 0.0]
    b = [0.0, 1.0]
    assert _cosine_similarity(a, b) == pytest.approx(0.0)


def test_cosine_zero_vector():
    assert _cosine_similarity([0.0, 0.0], [1.0, 2.0]) == 0.0


# -- emotional content filter -------------------------------------------------

def test_emotional_disqualifier_sad():
    assert _has_emotional_content("hey I'm feeling really sad today") is True


def test_emotional_disqualifier_stressed():
    assert _has_emotional_content("hi there, I'm so stressed out") is True


def test_emotional_disqualifier_not_ok():
    assert _has_emotional_content("hey, not doing well") is True


def test_no_emotional_content_greeting():
    assert _has_emotional_content("hi") is False


def test_no_emotional_content_thanks():
    assert _has_emotional_content("thanks a lot") is False


# -- classification with deterministic fake embedder --------------------------
# The conftest.py installs a SHA-256-based fake embedder globally.
# Identical strings get identical vectors → similarity 1.0.
# Different strings get different (pseudo-random) vectors → low similarity.

class _ControlledEmbedder:
    """Embedder that gives identical vectors for exact matches to templates,
    and very different vectors for anything else. Allows precise threshold
    testing."""

    def __init__(self, templates: dict[str, float]):
        """templates: mapping from text → similarity to return vs query."""
        self._templates = templates
        self._dim = 384

    def _unit_vec(self, seed: int) -> List[float]:
        """Deterministic unit vector from a seed."""
        import hashlib
        h = hashlib.sha256(seed.to_bytes(4, "big")).digest()
        raw = [(h[i % len(h)] - 128) / 128.0 for i in range(self._dim)]
        norm = math.sqrt(sum(x * x for x in raw))
        return [x / norm for x in raw]

    def embed_passages(self, texts: Iterable[str]) -> List[List[float]]:
        return [self._unit_vec(hash(t)) for t in texts]

    def embed_query(self, text: str) -> List[float]:
        return self._unit_vec(hash(text))


@pytest.fixture(autouse=True)
def _reset_cache():
    """Ensure template cache is fresh for each test."""
    reset_template_cache()
    yield
    reset_template_cache()


def test_exact_greeting_is_hit():
    """Identical string to a template → similarity 1.0 → hit."""
    result = classify_fast_lane("hi")
    # With the SHA-256 fake embedder, embed_query("hi") == embed_passages(["hi"])
    # because the fake doesn't apply the bge query prefix.
    assert result.hit is True
    assert result.category == "greeting"
    assert result.best_similarity == pytest.approx(1.0, abs=0.01)


def test_exact_match_short_circuits_embedding():
    class _ExplodingEmbedder:
        def embed_passages(self, texts):
            raise AssertionError("exact match should not call embed_passages")

        def embed_query(self, text):
            raise AssertionError("exact match should not call embed_query")

    result = classify_fast_lane("  Hi  ", embedder=_ExplodingEmbedder())
    assert result.hit is True
    assert result.category == "greeting"
    assert result.best_similarity == 1.0


def test_exact_gratitude_is_hit():
    result = classify_fast_lane("thanks")
    assert result.hit is True
    assert result.category == "gratitude"
    assert result.best_similarity == pytest.approx(1.0, abs=0.01)


def test_exact_thank_you_is_hit():
    result = classify_fast_lane("thank you")
    assert result.hit is True
    assert result.category == "gratitude"


def test_long_input_skips_embedding():
    """Inputs > 60 chars are short-circuited without embedding."""
    result = classify_fast_lane("hey what is the weather going to be like tomorrow in the afternoon around 3pm")
    assert result.hit is False
    assert result.latency_ms == 0.0


def test_emotional_greeting_not_bypassed():
    """'hey I'm stressed out' should NOT bypass even though it starts with 'hey'."""
    result = classify_fast_lane("hey I'm stressed out")
    assert result.hit is False


def test_emotional_sad_not_bypassed():
    result = classify_fast_lane("hi, I feel sad today")
    assert result.hit is False


def test_weather_question_not_bypassed():
    """A question that starts with 'hey' but asks for info must not bypass."""
    result = classify_fast_lane("hey what's the weather")
    assert result.hit is False


def test_near_miss_flag():
    """If similarity > 0.80 but < 0.90, near_miss should be True."""
    result = classify_fast_lane("hey what's the weather")
    # The fake embedder gives different vectors for different strings,
    # so this will either be a near-miss or a clean miss depending on
    # the hash. We test the structural invariant.
    if result.best_similarity > NEAR_MISS_THRESHOLD and result.best_similarity < FAST_LANE_THRESHOLD:
        assert result.near_miss is True
    else:
        # Either a hit or a clean miss — near_miss must match.
        assert result.near_miss == (
            result.best_similarity > NEAR_MISS_THRESHOLD and not result.hit
        )


def test_result_has_latency():
    result = classify_fast_lane("hello")
    assert result.latency_ms >= 0.0


def test_empty_input():
    result = classify_fast_lane("")
    # Empty string is short, won't match emotional markers, but will
    # have low similarity to any template.
    assert isinstance(result, FastLaneResult)


def test_normalize_fast_lane_text_lowercases_and_collapses_spaces():
    assert _normalize_fast_lane_text("  Thank   You  ") == "thank you"


def test_whitespace_only():
    result = classify_fast_lane("   ")
    assert isinstance(result, FastLaneResult)


def test_gratitude_variants():
    """Multiple gratitude phrasings that match templates exactly."""
    for phrase in ["thanks", "thank you", "thx", "ty"]:
        result = classify_fast_lane(phrase)
        assert result.hit is True, f"Expected hit for {phrase!r}"
        assert result.category == "gratitude"


def test_greeting_variants():
    """Multiple greeting phrasings that match templates exactly."""
    for phrase in ["hi", "hey", "hello", "yo", "sup", "howdy"]:
        result = classify_fast_lane(phrase)
        assert result.hit is True, f"Expected hit for {phrase!r}"
        assert result.category == "greeting"


def test_category_is_greeting_or_gratitude():
    """On a hit, category must be one of the two supported values."""
    for phrase in ["hi", "thanks"]:
        result = classify_fast_lane(phrase)
        assert result.category in ("greeting", "gratitude")


def test_frustrated_greeting_blocked():
    result = classify_fast_lane("hey, I'm really frustrated")
    assert result.hit is False


def test_worried_greeting_blocked():
    result = classify_fast_lane("hi, I'm worried about something")
    assert result.hit is False


def test_bad_day_blocked():
    result = classify_fast_lane("hey, having a bad day")
    assert result.hit is False
