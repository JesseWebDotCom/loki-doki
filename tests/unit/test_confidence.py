"""Tests for the pure update_confidence math.

Pinned properties (DO NOT relax without updating the design doc):
1. Confirmation strictly increases confidence (or holds at MAX).
2. Contradiction strictly decreases confidence (or holds at MIN).
3. The function is bounded in [MIN_CONFIDENCE, MAX_CONFIDENCE].
4. weight=0 returns the current value (clamped).
5. weight=1 jumps straight to the target (clamped).
"""
import pytest

from datetime import datetime, timedelta, timezone

from lokidoki.core.confidence import (
    DEFAULT_CONFIDENCE,
    HALF_LIFE_DAYS,
    MAX_CONFIDENCE,
    MIN_CONFIDENCE,
    effective_confidence,
    is_single_value_predicate,
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


class TestEffectiveConfidence:
    def _ts(self, days_ago: float) -> str:
        t = datetime.now(timezone.utc) - timedelta(days=days_ago)
        return t.strftime("%Y-%m-%d %H:%M:%S")

    def test_fresh_equals_stored(self):
        assert effective_confidence(0.8, self._ts(0)) == pytest.approx(0.8, abs=1e-3)

    def test_one_half_life_halves(self):
        eff = effective_confidence(0.8, self._ts(HALF_LIFE_DAYS))
        assert eff == pytest.approx(0.4, abs=0.01)

    def test_identity_no_decay(self):
        eff = effective_confidence(0.8, self._ts(10000), category="identity")
        assert eff == pytest.approx(0.8, abs=1e-3)

    def test_relationship_no_decay(self):
        eff = effective_confidence(0.8, self._ts(10000), category="relationship")
        assert eff == pytest.approx(0.8, abs=1e-3)


class TestSingleValuePredicate:
    def test_known(self):
        assert is_single_value_predicate("name")
        assert is_single_value_predicate("is_named")
        assert is_single_value_predicate("lives_in")

    def test_unknown(self):
        assert not is_single_value_predicate("likes")
        assert not is_single_value_predicate("visited")
