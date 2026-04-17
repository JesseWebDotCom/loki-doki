"""Tests for slot-compatibility scoring in the router."""
from __future__ import annotations

from pytest import approx

from lokidoki.orchestrator.routing.router import (
    SLOT_MISSING_PENALTY,
    SLOT_PRESENT_BONUS,
    _apply_slot_adjustment,
    route_chunk,
)
from lokidoki.orchestrator.core.types import RequestChunk


class TestApplySlotAdjustment:
    """Unit tests for _apply_slot_adjustment."""

    def test_penalty_for_missing_required_slot(self):
        """A capability missing its required slot should lose score."""
        # get_weather requires (location,). No GPE/LOC entity → penalty.
        score = _apply_slot_adjustment("get_weather", 0.80, [])
        assert score < 0.80
        assert score == approx(0.80 - SLOT_MISSING_PENALTY)

    def test_bonus_for_present_required_slot(self):
        """A capability with its required slot filled should gain score."""
        entities = [("Chicago", "GPE")]
        score = _apply_slot_adjustment("get_weather", 0.80, entities)
        assert score > 0.80
        assert score == approx(0.80 + SLOT_PRESENT_BONUS)

    def test_no_change_for_unknown_capability(self):
        """Capabilities not in CAPABILITY_PARAMS are unchanged."""
        score = _apply_slot_adjustment("greeting_response", 0.80, [("hi", "INTJ")])
        assert score == 0.80

    def test_multiple_slots_mixed(self):
        """news_search needs (location, person). One present, one missing."""
        entities = [("Paris", "GPE")]
        score = _apply_slot_adjustment("news_search", 0.80, entities)
        # location present (+0.05), person missing (-0.10) → net -0.05
        assert score == approx(0.80 + SLOT_PRESENT_BONUS - SLOT_MISSING_PENALTY)

    def test_all_slots_present(self):
        """news_search with both location and person present."""
        entities = [("Paris", "GPE"), ("Leia", "PERSON")]
        score = _apply_slot_adjustment("news_search", 0.80, entities)
        assert score == approx(0.80 + 2 * SLOT_PRESENT_BONUS)

    def test_all_slots_missing(self):
        """news_search with no relevant entities."""
        entities = [("yesterday", "DATE")]
        score = _apply_slot_adjustment("news_search", 0.80, entities)
        assert score == approx(0.80 - 2 * SLOT_MISSING_PENALTY)

    def test_loc_satisfies_location_slot(self):
        """LOC entities (not just GPE) should satisfy the location param."""
        entities = [("Mount Everest", "LOC")]
        score = _apply_slot_adjustment("get_weather", 0.80, entities)
        assert score == approx(0.80 + SLOT_PRESENT_BONUS)

    def test_person_satisfies_person_slot(self):
        """PERSON entity satisfies the person param for lookup_person_birthday."""
        entities = [("Anakin", "PERSON")]
        score = _apply_slot_adjustment("lookup_person_birthday", 0.80, entities)
        assert score == approx(0.80 + SLOT_PRESENT_BONUS)


class TestRouteChunkSlotScoring:
    """Integration: route_chunk with extracted_entities."""

    def test_no_entities_backward_compat(self):
        """Without extracted_entities, behavior is unchanged."""
        chunk = RequestChunk(text="hello world", index=0)
        # Should not crash — entities default to None.
        result = route_chunk(chunk)
        assert result.capability  # some capability assigned

    def test_missing_slots_can_demote_below_floor(self):
        """A capability above the floor but missing slots can drop below it.

        We can't easily control cosine scores without mocking the runtime,
        so this test verifies the adjustment function's math ensures a
        score just above the floor drops below when slots are missing.
        """
        # Simulated: score 0.58, missing 1 required slot → 0.48 < 0.55
        score = _apply_slot_adjustment("get_weather", 0.58, [])
        assert score < 0.55, f"Expected below floor, got {score}"

    def test_present_slots_can_promote_above_floor(self):
        """A capability below the floor with present slots can rise above it.

        Score 0.52 + bonus 0.05 = 0.57 > 0.55.
        """
        entities = [("Chicago", "GPE")]
        score = _apply_slot_adjustment("get_weather", 0.52, entities)
        assert score > 0.55, f"Expected above floor, got {score}"

    def test_slot_scoring_flips_winner(self):
        """Scenario from the chunk doc: high cosine + missing slots loses
        to lower cosine + filled slots."""
        # Skill A: get_weather at 0.92, missing location → 0.82
        score_a = _apply_slot_adjustment("get_weather", 0.92, [])
        # Skill B: get_weather at 0.88, location present → 0.93
        entities_b = [("Seattle", "GPE")]
        score_b = _apply_slot_adjustment("get_weather", 0.88, entities_b)
        assert score_b > score_a, (
            f"Filled-slot score ({score_b}) should beat missing-slot score ({score_a})"
        )
