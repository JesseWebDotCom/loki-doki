"""Tests for the Pydantic-validated decomposer repair loop.

The fixtures live in ``tests/fixtures/decomposer/`` and stand in for
canonical USER_INPUT examples; the tests don't actually run the model,
they only validate the items the model would *return* for each input.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lokidoki.core.decomposer_repair import (
    LongTermItem,
    coerce_item,
    parse_items,
    repair_long_term_memory,
)


FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "decomposer"


def _load(name: str) -> str:
    return (FIXTURE_DIR / name).read_text().strip()


class TestLongTermItem:
    def test_self_fact_validates(self):
        item = LongTermItem.model_validate({
            "subject_type": "self", "subject_name": "",
            "predicate": "occupation", "value": "electrician", "kind": "fact",
        })
        assert item.subject_type == "self"
        assert item.value == "electrician"

    def test_person_fact_validates(self):
        item = LongTermItem.model_validate({
            "subject_type": "person", "subject_name": "Mark",
            "predicate": "location", "value": "Denver", "kind": "fact",
        })
        assert item.subject_name == "Mark"

    def test_relationship_requires_relationship_kind(self):
        with pytest.raises(Exception):
            LongTermItem.model_validate({
                "subject_type": "person", "subject_name": "Mark",
                "predicate": "is", "value": "brother", "kind": "relationship",
            })

    def test_relationship_must_target_person(self):
        with pytest.raises(Exception):
            LongTermItem.model_validate({
                "subject_type": "self", "subject_name": "",
                "predicate": "has", "value": "a brother",
                "kind": "relationship", "relationship_kind": "brother",
            })

    def test_person_subject_requires_name(self):
        with pytest.raises(Exception):
            LongTermItem.model_validate({
                "subject_type": "person", "subject_name": "",
                "predicate": "x", "value": "y", "kind": "fact",
            })


class TestParseItems:
    def test_partition_good_and_bad(self):
        items = [
            {"subject_type": "self", "predicate": "p", "value": "v", "kind": "fact"},
            {"predicate": "", "value": "", "kind": "fact"},          # bad
            "not even an object",                                       # bad
        ]
        good, errors = parse_items(items)
        assert len(good) == 1
        assert len(errors) == 2
        assert errors[1]["errors"][0]["msg"] == "item must be an object"


class TestCoerceItem:
    """Pre-validation salvage covers gemma's two most common misshapes."""

    def test_self_relationship_demotes_to_fact(self):
        out = coerce_item({
            "subject_type": "self", "subject_name": "",
            "predicate": "is_excited_to_see", "value": "the supergirl movie",
            "kind": "relationship", "relationship_kind": "excited_to_see",
        })
        assert out["kind"] == "fact"
        assert out["relationship_kind"] is None

    def test_person_without_name_recovers_from_input(self):
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "",
                "predicate": "loves", "value": "everything superman",
                "kind": "fact",
            },
            original_input="My coworker Jacques loves everything superman",
        )
        assert out["subject_type"] == "person"
        assert out["subject_name"] == "Jacques"

    def test_person_without_name_demotes_to_self_when_unrecoverable(self):
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "",
                "predicate": "loves", "value": "coffee", "kind": "fact",
            },
            original_input="they love coffee",
        )
        assert out["subject_type"] == "self"

    def test_person_relationship_without_name_demotes_to_self_fact(self):
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "",
                "predicate": "is", "value": "coworker",
                "kind": "relationship", "relationship_kind": "coworker",
            },
            original_input="i have a coworker",
        )
        assert out["subject_type"] == "self"
        assert out["kind"] == "fact"
        assert out["relationship_kind"] is None

    def test_blocklist_skips_franchise_words(self):
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "",
                "predicate": "is", "value": "great", "kind": "fact",
            },
            original_input="The new Supergirl trailer looks good",
        )
        # 'Supergirl' is blocklisted — should fall back to self.
        assert out["subject_type"] == "self"

    def test_titlecases_lowercase_person_name(self):
        # gemma sometimes lowercases proper nouns. UIs and dedupe paths
        # downstream rely on canonical capitalization, so normalize here.
        out = coerce_item({
            "subject_type": "person", "subject_name": "tom",
            "predicate": "loves", "value": "Halo", "kind": "fact",
        })
        assert out["subject_name"] == "Tom"

    def test_drops_tautological_self_naming_fact(self):
        # "Tom is Tom" / "Tom named Tom" — gemma loves emitting these
        # alongside the real fact. They're noise. coerce_item returns
        # None to signal drop.
        for predicate in ("is", "named", "is_named", "name"):
            out = coerce_item({
                "subject_type": "person", "subject_name": "Tom",
                "predicate": predicate, "value": "Tom", "kind": "fact",
            })
            assert out is None, f"should drop tautology with predicate={predicate}"

    def test_drops_self_naming_tautology_case_insensitive(self):
        out = coerce_item({
            "subject_type": "person", "subject_name": "tom",
            "predicate": "is", "value": "TOM", "kind": "fact",
        })
        assert out is None

    def test_strips_whitespace_in_string_fields(self):
        out = coerce_item({
            "subject_type": " self ", "subject_name": " ",
            "predicate": " loves ", "value": " coffee ", "kind": " fact ",
        })
        assert out["subject_type"] == "self"
        assert out["predicate"] == "loves"
        assert out["value"] == "coffee"


class TestParseItemsCoercion:
    def test_self_relationship_lands_as_fact(self):
        good, errors = parse_items(
            [{
                "subject_type": "self", "predicate": "is_excited_to_see",
                "value": "supergirl movie", "kind": "relationship",
                "relationship_kind": "excited_to_see",
            }],
            original_input="im so excited to see the supergirl movie",
        )
        assert errors == []
        assert len(good) == 1
        assert good[0].kind == "fact"

    def test_person_no_name_recovered(self):
        good, errors = parse_items(
            [{
                "subject_type": "person", "predicate": "loves",
                "value": "everything superman", "kind": "fact",
            }],
            original_input="My coworker Jacques loves everything superman",
        )
        assert errors == []
        assert len(good) == 1
        assert good[0].subject_name == "Jacques"


class TestRepairLoop:
    @pytest.mark.anyio
    async def test_keeps_initially_good_items(self):
        items = [
            {"subject_type": "self", "predicate": "p", "value": "v", "kind": "fact"},
        ]

        async def never_called(_p, _s):
            raise AssertionError("repair_call should not run when nothing fails")

        out = await repair_long_term_memory(
            items, original_input="x", repair_call=never_called
        )
        assert len(out) == 1

    @pytest.mark.anyio
    async def test_repairs_a_broken_item(self):
        bad_items = [
            # Missing relationship_kind on a relationship — repair should fix.
            {
                "subject_type": "person", "subject_name": "Mark",
                "predicate": "is", "value": "brother", "kind": "relationship",
            },
        ]

        repaired_payload = json.dumps([
            {
                "subject_type": "person", "subject_name": "Mark",
                "predicate": "is", "value": "brother", "kind": "relationship",
                "relationship_kind": "brother",
            }
        ])

        calls: list[str] = []

        async def fake_repair(prompt: str, _schema: dict) -> str:
            calls.append(prompt)
            return repaired_payload

        out = await repair_long_term_memory(
            bad_items,
            original_input="my brother Mark",
            repair_call=fake_repair,
        )
        assert len(out) == 1
        assert out[0].relationship_kind == "brother"
        assert len(calls) == 1
        # The repair prompt should quote the failing item back to the model
        # so the correction is targeted, not "regenerate everything".
        assert "Mark" in calls[0]
        assert "relationship_kind" in calls[0]

    @pytest.mark.anyio
    async def test_drops_unrepairable_items(self):
        bad_items = [
            {"predicate": "", "value": "", "kind": "fact"},
        ]

        async def fake_repair(_p, _s):
            # Returns the same garbage indefinitely.
            return json.dumps([{"predicate": "", "value": "", "kind": "fact"}])

        out = await repair_long_term_memory(
            bad_items, original_input="x", repair_call=fake_repair
        )
        assert out == []

    @pytest.mark.anyio
    async def test_breaks_loop_on_repair_call_exception(self):
        bad_items = [
            {"predicate": "", "value": "", "kind": "fact"},
        ]
        attempts = 0

        async def boom(_p, _s):
            nonlocal attempts
            attempts += 1
            raise RuntimeError("ollama down")

        out = await repair_long_term_memory(
            bad_items, original_input="x", repair_call=boom
        )
        assert out == []
        # Single attempt then bail — don't hammer Ollama on repeat failures.
        assert attempts == 1


class TestFixtures:
    """Sanity-check the canonical fixtures load and parse the way we expect."""

    def test_self_fact_fixture(self):
        assert "electrician" in _load("self_fact.txt")

    def test_person_fact_fixture(self):
        assert "Denver" in _load("person_fact.txt")

    def test_malformed_fixture_is_salvaged_by_coercion(self):
        # The fixture is gemma's classic misshape: person+relationship with
        # no name and no relationship_kind. Pre-coercion this dropped on
        # the floor; the salvage pass now demotes it to a self fact so the
        # predicate/value pair survives.
        raw = json.loads(_load("malformed.txt"))
        good, errors = parse_items(raw)
        assert errors == []
        assert len(good) == 1
        assert good[0].subject_type == "self"
        assert good[0].kind == "fact"
        assert good[0].value == "plumber"
