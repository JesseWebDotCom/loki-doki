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

    def test_entity_fact_validates(self):
        # Entities are named non-person things (movies, books, places).
        # They MUST have a subject_name; the subject_ref_id is null
        # (no people row), and persistence stores subject = lowercased name.
        item = LongTermItem.model_validate({
            "subject_type": "entity", "subject_name": "Biodome",
            "predicate": "was", "value": "pretty good", "kind": "preference",
        })
        assert item.subject_type == "entity"
        assert item.subject_name == "Biodome"
        assert item.kind == "preference"

    def test_entity_subject_requires_name(self):
        with pytest.raises(Exception):
            LongTermItem.model_validate({
                "subject_type": "entity", "subject_name": "",
                "predicate": "is", "value": "great", "kind": "preference",
            })

    def test_kind_enum_accepts_taxonomy(self):
        for kind in ("fact", "preference", "event", "advice"):
            LongTermItem.model_validate({
                "subject_type": "self", "subject_name": "",
                "predicate": "p", "value": "v", "kind": kind,
            })

    def test_kind_enum_rejects_unknown(self):
        with pytest.raises(Exception):
            LongTermItem.model_validate({
                "subject_type": "self", "subject_name": "",
                "predicate": "p", "value": "v", "kind": "garbage",
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

    def test_sentence_initial_proper_noun_survives(self):
        # The mirror of the "In" test: Camilla is a real proper noun even
        # when she only appears at sentence-initial position. The position-0
        # heuristic would wrongly drop her; the spaCy POS check keeps her.
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "Camilla",
                "predicate": "was terrified by", "value": "Insidious",
                "kind": "event", "relationship_kind": "sister-in-law",
            },
            original_input="Camilla was terrified by Insidious",
        )
        assert out is not None
        assert out["subject_name"] == "Camilla"

    def test_salvage2_recovers_camilla_not_preposition(self):
        # Real failing turn from production: gemma emitted a person item
        # with NO subject_name. The legacy regex salvage greedy-matched
        # "my sister in" → name="in" → wrote {person, In, was terrified
        # by, Insidious}. The spaCy-based salvage uses the dependency
        # parse instead — Camilla is parsed as the appositive of sister
        # (the actual relation NOUN), so we recover the right name.
        out = coerce_item(
            {
                "subject_type": "person",
                "predicate": "was terrified by",
                "value": "Insidious",
                "kind": "event",
                "relationship_kind": "sister-in-law",
                "category": "event",
            },
            original_input="My sister in law Camilla was terrified by the insidious movie",
        )
        assert out is not None
        assert out["subject_name"] == "Camilla"

    def test_sentence_initial_stopword_dropped_as_person_name(self):
        # "In was terrified by Insidious" — user typo'd "I" as "In".
        # gemma lifts "In" as a person because it's capitalized at sentence
        # start. The stopword guard must drop it instead of polluting the
        # people table with a fake "In" entry.
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "In",
                "predicate": "was terrified by", "value": "Insidious",
                "kind": "event",
            },
            original_input="In was terrified by Insidious",
        )
        assert out is None

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
        # 'Supergirl' is blocklisted, so the salvage demotes to self.
        # Then the bare-copula guard kicks in: predicate `is` + value
        # `great` + no first-person leader + no recoverable entity =
        # noise. The fragment is correctly dropped — the user never
        # claimed THEY were great.
        assert out is None

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

    def test_drops_self_is_name_when_input_references_other_person(self):
        """gemma misreads 'my brother artie loves movies' as {self,is,artie}.

        The salvage must drop this — the user is NOT named Artie. This
        is the regression that planted three bogus self-facts in the
        Memory tab in the live demo.
        """
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "is", "value": "artie", "kind": "fact",
                "category": "general",
            },
            original_input="my brother artie loves movies",
        )
        assert out is None

    def test_self_fact_reattributed_to_person_via_relation_pair(self):
        """{self, loves, movies} from 'my brother artie loves movies'
        must be promoted to a person fact about Artie."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "loves", "value": "movies", "kind": "fact",
                "category": "preference",
            },
            original_input="my brother artie loves movies",
        )
        assert out is not None
        assert out["subject_type"] == "person"
        assert out["subject_name"] == "Artie"
        assert out["predicate"] == "loves"
        assert out["value"] == "movies"

    def test_self_fact_unchanged_when_no_relation_pair(self):
        """A genuine self-fact like 'I love hiking' must NOT be reattributed."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "loves", "value": "hiking", "kind": "fact",
                "category": "preference",
            },
            original_input="I love hiking",
        )
        assert out is not None
        assert out["subject_type"] == "self"

    def test_relation_pair_does_not_match_unknown_relation(self):
        """'my favorite restaurant Olive Garden' must NOT trigger reattribution."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "loves", "value": "breadsticks", "kind": "fact",
                "category": "preference",
            },
            original_input="my favorite restaurant Olive serves breadsticks",
        )
        assert out is not None
        assert out["subject_type"] == "self"

    def test_drops_self_naming_tautology_case_insensitive(self):
        out = coerce_item({
            "subject_type": "person", "subject_name": "tom",
            "predicate": "is", "value": "TOM", "kind": "fact",
        })
        assert out is None

    def test_bare_copula_self_fragment_dropped_when_no_entity(self):
        """`{self, was, pretty good}` from a context with no recoverable
        named entity is unsalvageable noise — must drop."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "was", "value": "pretty good", "kind": "fact",
            },
            original_input="it was pretty good honestly",
        )
        assert out is None

    def test_bare_copula_self_fragment_promoted_to_entity(self):
        """The Biodome regression. `{self, was, pretty good}` extracted
        from "biodome was pretty good" must be promoted to an entity
        fact about Biodome, NOT stored as a self claim."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "was", "value": "pretty good", "kind": "fact",
            },
            original_input="biodome was pretty good",
        )
        assert out is not None
        assert out["subject_type"] == "entity"
        assert out["subject_name"].lower() == "biodome"
        assert out["value"] == "pretty good"
        assert out["kind"] == "preference"

    def test_bare_copula_self_fragment_promoted_for_multiword_entity(self):
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "was", "value": "amazing", "kind": "fact",
            },
            original_input="St Elmos Fire was amazing",
        )
        assert out is not None
        assert out["subject_type"] == "entity"
        assert "Elmos" in out["subject_name"]

    def test_self_fragment_with_entity_in_value_dropped(self):
        """`{self, was, the movie biodome}` — object→value inversion.
        Can't safely promote (we don't know which token is the entity),
        so the only correct move is to drop the fragment entirely."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "was", "value": "the movie biodome", "kind": "fact",
            },
            original_input="biodome was the movie biodome",
        )
        assert out is None

    def test_tautology_caught_after_name_recovery(self):
        """gemma emits {person, "", is, "artie"} from "my brother artie
        loves movies". Salvage 2 fills in subject_name="Artie", then
        the FINAL tautology pass must drop {Artie, is, "artie"}."""
        out = coerce_item(
            {
                "subject_type": "person", "subject_name": "",
                "predicate": "is", "value": "artie",
                "kind": "relationship", "relationship_kind": "brother",
            },
            original_input="My brother artie loves movies",
        )
        assert out is None

    def test_entity_recovery_rejects_phrase_with_embedded_copula(self):
        """The greedy-regex bug. "Who is craig nelson and is he related"
        used to capture "Who is craig nelson and" as the entity prefix
        because of the SECOND `is` later in the sentence. The post-filter
        must reject any captured phrase containing copulas/question words."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "is", "value": "Craig Nelson", "kind": "fact",
            },
            original_input="Who is craig nelson and is he related to judd nelson",
        )
        assert out is None

    def test_drops_garbage_person_name_with_question_words(self):
        """gemma sometimes lifts an entire question fragment into
        subject_name. 'Who Is Craig Nelson And' is not a person."""
        out = coerce_item(
            {
                "subject_type": "person",
                "subject_name": "Who Is Craig Nelson And",
                "predicate": "is", "value": "Craig Nelson", "kind": "fact",
            },
            original_input="who is craig nelson and judd nelson",
        )
        assert out is None

    def test_drops_garbage_person_name_too_long(self):
        out = coerce_item(
            {
                "subject_type": "person",
                "subject_name": "Mark Smith The Plumber From Denver",
                "predicate": "lives", "value": "Denver", "kind": "fact",
            },
            original_input="...",
        )
        assert out is None

    def test_drops_self_with_proper_noun_value(self):
        """Subject/object inversion: {self, is_related_to, Judd Nelson}
        is not about the user. Drop unless the input clearly anchors
        to first person."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "is_related_to", "value": "Judd Nelson",
                "kind": "fact",
            },
            original_input="st elmos fire features judd nelson",
        )
        assert out is None

    def test_self_with_proper_noun_value_kept_when_first_person(self):
        """`I met Judd Nelson` -> {self, met, Judd Nelson} is legit."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "met", "value": "Judd Nelson", "kind": "event",
            },
            original_input="I met Judd Nelson at a coffee shop",
        )
        assert out is not None
        assert out["subject_type"] == "self"
        assert out["value"] == "Judd Nelson"

    def test_legit_self_past_tense_not_dropped(self):
        """`I was happy yesterday` -> `{self, was, happy}` is a real
        self-claim. The bare-copula guard must not strip it just because
        the predicate is `was`. The first-person leader in the input is
        the signal we trust."""
        out = coerce_item(
            {
                "subject_type": "self", "subject_name": "",
                "predicate": "was", "value": "happy", "kind": "fact",
            },
            original_input="I was happy yesterday",
        )
        assert out is not None
        assert out["subject_type"] == "self"
        assert out["value"] == "happy"

    def test_strips_whitespace_in_string_fields(self):
        out = coerce_item({
            "subject_type": " self ", "subject_name": " ",
            "predicate": " loves ", "value": " coffee ", "kind": " fact ",
        })
        assert out["subject_type"] == "self"
        assert out["predicate"] == "loves"
        assert out["value"] == "coffee"


class TestEntityCrossItemRecovery:
    """Salvage 6: borrow an entity name from a sibling item's value field."""

    def test_entity_no_name_recovered_from_sibling_value(self):
        # Production failure: for "Camilla was terrified by Insidious"
        # gemma emits the entity item with NO subject_name, but the
        # sibling person item has value="Insidious". parse_items pools
        # candidate names from sibling values and feeds them into
        # coerce_item, which fills the entity item's missing name.
        items = [
            {
                "subject_type": "person", "subject_name": "Camilla",
                "predicate": "was terrified by", "value": "Insidious",
                "kind": "event", "relationship_kind": "sister-in-law",
            },
            {
                "subject_type": "entity", "predicate": "is",
                "value": "a scary movie", "kind": "fact", "category": "media",
            },
        ]
        good, errors = parse_items(
            items, original_input="Camilla was terrified by Insidious",
        )
        assert errors == []
        assert len(good) == 2
        entity = next(g for g in good if g.subject_type == "entity")
        assert entity.subject_name == "Insidious"
        assert entity.value == "a scary movie"


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
