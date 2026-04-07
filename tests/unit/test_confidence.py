"""Tests for the pure update_confidence math.

Pinned properties (DO NOT relax without updating the design doc):
1. Confirmation strictly increases confidence (or holds at MAX).
2. Contradiction strictly decreases confidence (or holds at MIN).
3. The function is bounded in [MIN_CONFIDENCE, MAX_CONFIDENCE].
4. weight=0 returns the current value (clamped).
5. weight=1 jumps straight to the target (clamped).
"""
import pytest

from lokidoki.core.confidence import (
    DEFAULT_CONFIDENCE,
    MAX_CONFIDENCE,
    MIN_CONFIDENCE,
    update_confidence,
)


class TestUpdateConfidence:
    def test_confirmation_increases(self):
        new = update_confidence(0.5, confirmed=True)
        assert new > 0.5

    def test_contradiction_decreases(self):
        new = update_confidence(0.5, confirmed=False)
        assert new < 0.5

    def test_bounded_above(self):
        # Even with weight=1 we should clamp at MAX.
        new = update_confidence(0.99, confirmed=True, weight=1.0)
        assert new == MAX_CONFIDENCE

    def test_bounded_below(self):
        new = update_confidence(0.01, confirmed=False, weight=1.0)
        assert new == MIN_CONFIDENCE

    def test_idempotent_at_max(self):
        new = update_confidence(MAX_CONFIDENCE, confirmed=True)
        assert new == MAX_CONFIDENCE

    def test_idempotent_at_min(self):
        new = update_confidence(MIN_CONFIDENCE, confirmed=False)
        assert new == MIN_CONFIDENCE

    def test_zero_weight_clamps_to_current(self):
        # weight=0 means no movement; should still clamp into bounds.
        assert update_confidence(0.5, confirmed=True, weight=0.0) == 0.5
        assert update_confidence(0.0, confirmed=True, weight=0.0) == MIN_CONFIDENCE

    def test_weight_one_jumps_to_target(self):
        assert update_confidence(0.5, confirmed=True, weight=1.0) == MAX_CONFIDENCE
        assert update_confidence(0.5, confirmed=False, weight=1.0) == MIN_CONFIDENCE

    def test_repeated_confirmations_converge_to_max(self):
        c = DEFAULT_CONFIDENCE
        for _ in range(50):
            c = update_confidence(c, confirmed=True)
        assert c == pytest.approx(MAX_CONFIDENCE, abs=1e-6)

    def test_repeated_contradictions_converge_to_min(self):
        c = DEFAULT_CONFIDENCE
        for _ in range(50):
            c = update_confidence(c, confirmed=False)
        assert c == pytest.approx(MIN_CONFIDENCE, abs=1e-6)

    def test_invalid_weight_raises(self):
        with pytest.raises(ValueError):
            update_confidence(0.5, confirmed=True, weight=-0.1)
        with pytest.raises(ValueError):
            update_confidence(0.5, confirmed=True, weight=1.5)
