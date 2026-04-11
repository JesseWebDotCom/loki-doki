"""Phase 4 unit tests: retrieval scoring, novelty penalty, near-duplicate
suppression, RapidFuzz alias matching, noisy entity/name repair, and
graph-walk referent expansion.

These tests cover the CODEX Phase 4 deliverables at the unit level.
Integration tests live in tests/integration/test_phase4_retrieval_quality.py.
"""
from __future__ import annotations

import pytest

from lokidoki.core.decomposer import Ask
from lokidoki.core.retrieval_scoring import (
    CONTRADICTION_PENALTY,
    ENTITY_BOOST,
    NOVELTY_PENALTY,
    are_near_duplicate_facts,
    contradiction_penalty_for_fact,
    fact_matches_query,
    fact_phrase,
    fuzzy_expand_query,
    normalize_text,
    recency_bonus,
    relation_match_bonus,
    score_memory_candidate,
)
from lokidoki.core.graph_walk_resolution import (
    candidate_aliases,
    extract_relation_chain,
    fuzzy_match_name,
    normalize_query,
)


def _ask(**overrides) -> Ask:
    base = {"ask_id": "a1", "intent": "direct_chat", "distilled_query": "test"}
    base.update(overrides)
    return Ask(**base)


# ---------- scoring math ----------


class TestScoreMemoryCandidate:
    def test_higher_retrieval_score_produces_higher_total(self):
        base = {
            "id": 1, "subject": "self", "subject_type": "self",
            "predicate": "likes", "value": "music",
            "confidence": 0.8, "status": "active",
        }
        high = {**base, "score": 0.9}
        low = {**base, "id": 2, "score": 0.3}
        kw = dict(
            bucket="semantic_profile", user_input="test",
            asks=[], retrieval_rank=0,
            session_seen_fact_ids=set(), entity_boost_enabled=False,
        )
        assert score_memory_candidate(high, **kw) > score_memory_candidate(low, **kw)

    def test_lower_rank_index_gets_higher_rank_bonus(self):
        fact = {
            "id": 1, "subject": "self", "subject_type": "self",
            "predicate": "likes", "value": "music",
            "confidence": 0.8, "status": "active", "score": 0.5,
        }
        kw = dict(
            bucket="semantic_profile", user_input="test",
            asks=[], session_seen_fact_ids=set(),
            entity_boost_enabled=False,
        )
        rank0 = score_memory_candidate(fact, retrieval_rank=0, **kw)
        rank5 = score_memory_candidate(fact, retrieval_rank=5, **kw)
        assert rank0 > rank5

    def test_higher_confidence_boosts_score(self):
        base = {
            "id": 1, "subject": "self", "subject_type": "self",
            "predicate": "likes", "value": "music",
            "status": "active", "score": 0.5,
        }
        high_conf = {**base, "confidence": 0.95}
        low_conf = {**base, "id": 2, "confidence": 0.3}
        kw = dict(
            bucket="semantic_profile", user_input="test",
            asks=[], retrieval_rank=0,
            session_seen_fact_ids=set(), entity_boost_enabled=False,
        )
        assert score_memory_candidate(high_conf, **kw) > score_memory_candidate(low_conf, **kw)

    def test_all_components_combine_additively(self):
        fact = {
            "id": 1, "subject": "luke", "subject_type": "person",
            "subject_ref_id": 5, "predicate": "likes", "value": "movies",
            "confidence": 0.9, "status": "active", "score": 0.7,
            "last_observed_at": "2026-04-08 10:00:00",
        }
        ask = _ask(referent_type="person", referent_scope=["person"])
        total = score_memory_candidate(
            fact, bucket="relational_graph", user_input="what does luke like",
            asks=[ask], retrieval_rank=0,
            session_seen_fact_ids=set(), entity_boost_enabled=False,
        )
        # Should be positive and > each individual component
        assert total > 0.0
        assert total > float(fact["score"]) * 2.5  # more than just retrieval


# ---------- novelty penalty ----------


class TestNoveltyPenalty:
    def test_unseen_fact_has_no_penalty(self):
        fact = {"id": 10, "score": 0.5, "confidence": 0.8, "status": "active",
                "subject": "self", "subject_type": "self", "predicate": "likes", "value": "tea"}
        kw = dict(
            bucket="semantic_profile", user_input="test", asks=[],
            retrieval_rank=0, entity_boost_enabled=False,
        )
        unseen = score_memory_candidate(fact, session_seen_fact_ids=set(), **kw)
        seen = score_memory_candidate(fact, session_seen_fact_ids={10}, **kw)
        assert unseen - seen == pytest.approx(NOVELTY_PENALTY, abs=0.01)

    def test_novelty_penalty_applied_only_to_matching_ids(self):
        fact = {"id": 10, "score": 0.5, "confidence": 0.8, "status": "active",
                "subject": "self", "subject_type": "self", "predicate": "likes", "value": "tea"}
        kw = dict(
            bucket="semantic_profile", user_input="test", asks=[],
            retrieval_rank=0, entity_boost_enabled=False,
        )
        other_seen = score_memory_candidate(fact, session_seen_fact_ids={99, 100}, **kw)
        none_seen = score_memory_candidate(fact, session_seen_fact_ids=set(), **kw)
        assert other_seen == pytest.approx(none_seen, abs=0.001)

    def test_none_id_never_penalised(self):
        fact = {"id": None, "score": 0.5, "confidence": 0.8, "status": "active",
                "subject": "self", "subject_type": "self", "predicate": "likes", "value": "x"}
        kw = dict(
            bucket="semantic_profile", user_input="test", asks=[],
            retrieval_rank=0, entity_boost_enabled=False,
        )
        # Even with a filled set, no penalty because id is None
        assert score_memory_candidate(fact, session_seen_fact_ids={0, 1, 2}, **kw) == \
               score_memory_candidate(fact, session_seen_fact_ids=set(), **kw)


# ---------- contradiction penalty ----------


class TestContradictionPenalty:
    def test_active_fact_no_penalty(self):
        assert contradiction_penalty_for_fact({"status": "active"}) == 0.0

    def test_rejected_gets_full_penalty(self):
        assert contradiction_penalty_for_fact({"status": "rejected"}) == CONTRADICTION_PENALTY

    def test_superseded_gets_full_penalty(self):
        assert contradiction_penalty_for_fact({"status": "superseded"}) == CONTRADICTION_PENALTY

    def test_ambiguous_gets_partial_penalty(self):
        assert contradiction_penalty_for_fact({"status": "ambiguous"}) == 1.0

    def test_contradicted_gets_partial_penalty(self):
        assert contradiction_penalty_for_fact({"status": "contradicted"}) == 1.0


# ---------- recency bonus ----------


class TestRecencyBonus:
    def test_very_recent_gets_highest_bonus(self):
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        fact = {"last_observed_at": (now - timedelta(hours=6)).isoformat()}
        assert recency_bonus(fact) == pytest.approx(1.2, abs=0.01)

    def test_two_week_old_gets_medium_bonus(self):
        from datetime import datetime, timezone, timedelta
        fact = {"last_observed_at": (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()}
        assert recency_bonus(fact) == pytest.approx(0.8, abs=0.01)

    def test_ancient_fact_gets_zero(self):
        fact = {"last_observed_at": "2020-01-01T00:00:00+00:00"}
        assert recency_bonus(fact) == 0.0

    def test_no_timestamp_gets_zero(self):
        assert recency_bonus({}) == 0.0


# ---------- relation match bonus ----------


class TestRelationMatchBonus:
    def test_relational_graph_bucket_on_people_turn_gets_full_bonus(self):
        ask = _ask(referent_type="person")
        bonus = relation_match_bonus(
            bucket="relational_graph", user_input="who is luke",
            asks=[ask], fact={"subject": "luke", "predicate": "is", "value": "brother"},
        )
        assert bonus == 1.0

    def test_non_people_turn_gets_zero(self):
        ask = _ask(referent_type="unknown")
        bonus = relation_match_bonus(
            bucket="relational_graph", user_input="what's the weather",
            asks=[ask], fact={"subject": "luke", "predicate": "is", "value": "brother"},
        )
        assert bonus == 0.0

    def test_fuzzy_text_match_on_people_turn_gets_partial(self):
        ask = _ask(referent_type="person")
        bonus = relation_match_bonus(
            bucket="semantic_profile", user_input="does luke like movies",
            asks=[ask], fact={"subject": "luke", "predicate": "likes", "value": "movies"},
        )
        assert bonus == pytest.approx(0.65, abs=0.01)


# ---------- entity boost ----------


class TestEntityBoost:
    def test_entity_boost_when_enabled_and_matching(self):
        fact = {
            "id": 1, "subject": "cabin trip", "subject_type": "entity",
            "predicate": "status", "value": "planned",
            "confidence": 0.8, "status": "active", "score": 0.5,
        }
        kw = dict(
            bucket="episodic_threads", user_input="what about the cabin trip",
            asks=[], retrieval_rank=0, session_seen_fact_ids=set(),
        )
        with_boost = score_memory_candidate(fact, entity_boost_enabled=True, **kw)
        without_boost = score_memory_candidate(fact, entity_boost_enabled=False, **kw)
        assert with_boost - without_boost == pytest.approx(ENTITY_BOOST, abs=0.01)

    def test_entity_boost_does_not_apply_to_person_type(self):
        fact = {
            "id": 1, "subject": "luke", "subject_type": "person",
            "predicate": "likes", "value": "movies",
            "confidence": 0.8, "status": "active", "score": 0.5,
        }
        kw = dict(
            bucket="relational_graph", user_input="luke likes movies",
            asks=[], retrieval_rank=0, session_seen_fact_ids=set(),
        )
        with_boost = score_memory_candidate(fact, entity_boost_enabled=True, **kw)
        without_boost = score_memory_candidate(fact, entity_boost_enabled=False, **kw)
        assert with_boost == pytest.approx(without_boost, abs=0.001)


# ---------- near-duplicate suppression ----------


class TestNearDuplicateSuppression:
    def test_identical_facts_are_duplicates(self):
        a = {"subject": "self", "predicate": "likes", "value": "coffee"}
        b = {"subject": "self", "predicate": "likes", "value": "coffee"}
        assert are_near_duplicate_facts(a, b) is True

    def test_minor_phrasing_variation_is_duplicate(self):
        a = {"subject": "vermont cabin trip", "predicate": "status", "value": "still in planning"}
        b = {"subject": "vermont cabin trip", "predicate": "status", "value": "still planning"}
        assert are_near_duplicate_facts(a, b) is True

    def test_different_facts_are_not_duplicates(self):
        a = {"subject": "self", "predicate": "likes", "value": "coffee"}
        b = {"subject": "luke", "predicate": "enjoys", "value": "hiking in mountains"}
        assert are_near_duplicate_facts(a, b) is False

    def test_empty_phrase_never_duplicate(self):
        a = {"subject": "", "predicate": "", "value": ""}
        b = {"subject": "self", "predicate": "likes", "value": "tea"}
        assert are_near_duplicate_facts(a, b) is False


# ---------- noisy entity/name repair ----------


class TestFuzzyExpandQuery:
    def test_repairs_misspelled_person_name(self):
        expanded = fuzzy_expand_query("how is lukee doing", ["Luke", "Nora"])
        assert "luke" in expanded.lower()

    def test_no_expansion_for_exact_match(self):
        result = fuzzy_expand_query("how is luke doing", ["Luke", "Nora"])
        # Should not double-add luke since it's already in the query
        assert result == "how is luke doing"

    def test_repairs_misspelled_entity(self):
        expanded = fuzzy_expand_query("tell me about the cabbin trip", ["cabin trip", "Vermont"])
        assert "cabin trip" in expanded.lower()

    def test_empty_names_returns_query_unchanged(self):
        assert fuzzy_expand_query("hello world", []) == "hello world"

    def test_empty_query_returns_empty(self):
        assert fuzzy_expand_query("", ["Luke"]) == ""

    def test_no_repair_for_distant_match(self):
        # "xyz" is too different from "Luke" to trigger repair
        result = fuzzy_expand_query("xyz abc", ["Luke"])
        assert result == "xyz abc"

    def test_bigram_repair(self):
        expanded = fuzzy_expand_query(
            "how is tony jonson", ["Tony Johnson", "Amy Smith"]
        )
        assert "tony johnson" in expanded.lower()


# ---------- RapidFuzz alias matching ----------


class TestFuzzyMatchName:
    def test_exact_name_matches(self):
        rows = [
            {"id": 1, "name": "Luke", "aliases": "[]"},
            {"id": 2, "name": "Nora", "aliases": "[]"},
        ]
        result = fuzzy_match_name("luke", rows)
        assert result is not None
        assert result["name"] == "Luke"

    def test_alias_matches(self):
        rows = [
            {"id": 1, "name": "Anthony Johnson", "aliases": '["AJ", "Ant"]'},
        ]
        result = fuzzy_match_name("aj", rows, score_cutoff=80)
        assert result is not None
        assert result["name"] == "Anthony Johnson"

    def test_no_match_below_cutoff(self):
        rows = [{"id": 1, "name": "Luke", "aliases": "[]"}]
        result = fuzzy_match_name("zzzzz", rows)
        assert result is None

    def test_empty_choices_returns_none(self):
        assert fuzzy_match_name("luke", []) is None

    def test_empty_query_returns_none(self):
        assert fuzzy_match_name("", [{"id": 1, "name": "Luke", "aliases": "[]"}]) is None


class TestCandidateAliases:
    def test_extracts_name_and_json_aliases(self):
        row = {"id": 1, "name": "Anthony Johnson", "aliases": '["AJ", "Ant"]'}
        aliases = candidate_aliases(row)
        assert "anthony johnson" in aliases
        assert "aj" in aliases
        assert "ant" in aliases

    def test_handles_empty_aliases(self):
        row = {"id": 1, "name": "Luke", "aliases": "[]"}
        aliases = candidate_aliases(row)
        assert aliases == ["luke"]


# ---------- graph-walk referent expansion ----------


class TestExtractRelationChain:
    def test_my_sister(self):
        base, chain = extract_relation_chain("my sister")
        assert base == "__self__"
        assert chain == ["sister"]

    def test_johns_wife(self):
        base, chain = extract_relation_chain("John's wife")
        assert base == "john"
        assert chain == ["wife"]

    def test_my_fathers_brother(self):
        base, chain = extract_relation_chain("my father's brother")
        assert base == "__self__"
        assert chain == ["father", "brother"]

    def test_my_brothers_daughter(self):
        base, chain = extract_relation_chain("my brother's daughter")
        assert base == "__self__"
        assert chain == ["brother", "daughter"]

    def test_no_possessive_returns_empty(self):
        base, chain = extract_relation_chain("hello world")
        assert base == ""
        assert chain == []

    def test_empty_input(self):
        base, chain = extract_relation_chain("")
        assert base == ""
        assert chain == []


# ---------- fact_matches_query ----------


class TestFactMatchesQuery:
    def test_exact_substring_match(self):
        fact = {"subject": "coffee", "predicate": "is", "value": "a beverage"}
        assert fact_matches_query(fact, "I love coffee") is True

    def test_fuzzy_match(self):
        fact = {"subject": "luke", "predicate": "likes", "value": "movies"}
        assert fact_matches_query(fact, "does lukee like films") is True

    def test_no_match(self):
        fact = {"subject": "luke", "predicate": "likes", "value": "movies"}
        assert fact_matches_query(fact, "what's the weather today") is False

    def test_empty_query_no_match(self):
        fact = {"subject": "luke", "predicate": "likes", "value": "movies"}
        assert fact_matches_query(fact, "") is False
