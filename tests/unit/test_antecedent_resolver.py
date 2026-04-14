"""Tests for pre-routing antecedent resolution.

Covers pronoun substitution, session-state entity lookup, conversation-
history fallback, topic extraction, and the full resolve_antecedents
integration path.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import RequestChunk
from lokidoki.orchestrator.pipeline.antecedent import (
    _all_proper_noun_phrases,
    _entity_from_conversation_history,
    _entity_from_session_state,
    _extract_user_topic,
    _first_noun_phrase,
    _question_object,
    _resolve_entity_and_topic,
    _try_resolve,
    resolve_antecedents,
)


# ---------------------------------------------------------------------------
# _try_resolve — pronoun → entity substitution
# ---------------------------------------------------------------------------


class TestTryResolve:
    def test_replaces_it(self):
        assert _try_resolve("is it free", "Claude Cowork") == "is Claude Cowork free"

    def test_replaces_he(self):
        assert _try_resolve("what year was he on the masked singer", "Corey Feldman") == (
            "what year was Corey Feldman on the masked singer"
        )

    def test_replaces_she(self):
        assert _try_resolve("where was she born", "Marie Curie") == (
            "where was Marie Curie born"
        )

    def test_replaces_him(self):
        assert _try_resolve("tell me about him", "Corey Feldman") == (
            "tell me about Corey Feldman"
        )

    def test_replaces_her_object(self):
        assert _try_resolve("tell me about her", "Marie Curie") == (
            "tell me about Marie Curie"
        )

    def test_replaces_his_possessive(self):
        assert _try_resolve("what is his birthday", "Corey Feldman") == (
            "what is Corey Feldman's birthday"
        )

    def test_replaces_hers_possessive(self):
        assert _try_resolve("the award is hers", "Marie Curie") == (
            "the award is Marie Curie's"
        )

    def test_replaces_this(self):
        assert _try_resolve("is this any good", "Avatar") == "is Avatar any good"

    def test_replaces_that(self):
        assert _try_resolve("when was that released", "Avatar") == (
            "when was Avatar released"
        )

    def test_replaces_they(self):
        assert _try_resolve("are they still active", "The Beatles") == (
            "are The Beatles still active"
        )

    def test_replaces_them(self):
        assert _try_resolve("tell me about them", "The Beatles") == (
            "tell me about The Beatles"
        )

    def test_only_first_pronoun_replaced(self):
        result = _try_resolve("is he taller than him", "Corey Feldman")
        assert result.count("Corey Feldman") == 1
        assert result.startswith("is Corey Feldman")

    def test_no_pronoun_returns_unchanged(self):
        assert _try_resolve("what time is the movie", "Avatar") == "what time is the movie"

    def test_long_text_still_resolved(self):
        """Long sentences used to be skipped by a 12-word cap. Real speech
        (e.g. "I went to a Limp Bizkit concert with my daughter and saw him
        perform") routinely exceeds 12 words; dropping the cap lets the
        pronoun resolve. Gating moved to in-chunk antecedent detection."""
        long = "he was on the masked singer and also appeared in many other shows and things"
        assert _try_resolve(long, "Corey Feldman") == (
            "Corey Feldman was on the masked singer and also"
            " appeared in many other shows and things"
        )

    def test_in_chunk_antecedent_blocks_substitution(self):
        """If the current chunk introduces a new proper-noun antecedent
        before the pronoun, defer to that rather than the session entity.
        ("Tell me about Obi-Wan. Is he a Jedi?" — "he" = Obi-Wan.)"""
        text = "Obi-Wan trained Anakin and he was a Jedi Master"
        assert _try_resolve(text, "Corey Feldman") == text

    def test_lowercase_named_entity_does_not_block(self):
        """User speech often lacks capitalization ("limp bizkit concert").
        The in-chunk antecedent check relies on capitalization, so
        lowercased band/product names do not mask the session entity."""
        text = "i went to a limp bizkit concert with my daughter and saw him perform"
        assert _try_resolve(text, "Corey Feldman") == (
            "i went to a limp bizkit concert with my daughter"
            " and saw Corey Feldman perform"
        )

    def test_that_movie_not_substituted(self):
        """'that movie' uses 'that' as a determiner, not a pronoun —
        leave it for the post-routing media resolver."""
        assert _try_resolve("what was that movie", "Rogue One") == "what was that movie"

    def test_this_show_not_substituted(self):
        assert _try_resolve("is this show any good", "The Masked Singer") == (
            "is this show any good"
        )

    def test_that_standalone_substituted(self):
        """'that' at end of text is a standalone pronoun → substitute."""
        assert _try_resolve("tell me about that", "Avatar") == "tell me about Avatar"


# ---------------------------------------------------------------------------
# _all_proper_noun_phrases
# ---------------------------------------------------------------------------


class TestAllProperNounPhrases:
    def test_extracts_two_phrases(self):
        result = _all_proper_noun_phrases(
            "Corey Feldman was on The Masked Singer in 2024."
        )
        assert result == ["Corey Feldman", "The Masked Singer"]

    def test_single_phrase(self):
        result = _all_proper_noun_phrases("Claude Cowork is a desktop AI.")
        assert result == ["Claude Cowork"]

    def test_three_phrases(self):
        result = _all_proper_noun_phrases(
            "Corey Feldman was on The Masked Singer as Seal."
        )
        assert "Corey Feldman" in result
        assert "The Masked Singer" in result
        assert "Seal" in result

    def test_no_caps(self):
        assert _all_proper_noun_phrases("the weather is sunny today.") == []

    def test_empty(self):
        assert _all_proper_noun_phrases("") == []

    def test_skips_numbers(self):
        result = _all_proper_noun_phrases("Corey Feldman appeared in 2024.")
        assert result == ["Corey Feldman"]


# ---------------------------------------------------------------------------
# _entity_from_session_state — session-state entity lookup
# ---------------------------------------------------------------------------


class TestEntityFromSessionState:
    def test_prefers_person(self):
        recent = [
            {"name": "Avatar", "type": "movie"},
            {"name": "Corey Feldman", "type": "person"},
        ]
        entity, topic = _entity_from_session_state(recent)
        assert entity == "Corey Feldman"

    def test_falls_back_to_first(self):
        recent = [{"name": "Avatar", "type": "movie"}]
        entity, topic = _entity_from_session_state(recent)
        assert entity == "Avatar"

    def test_extracts_topic(self):
        recent = [
            {"name": "Corey Feldman", "type": "person"},
            {"name": "The Masked Singer", "type": "topic"},
        ]
        entity, topic = _entity_from_session_state(recent)
        assert entity == "Corey Feldman"
        assert topic == "The Masked Singer"

    def test_empty_list(self):
        entity, topic = _entity_from_session_state([])
        assert entity == ""
        assert topic == ""

    def test_skips_bad_entries(self):
        recent = [None, {"name": ""}, {"name": "Valid", "type": "person"}]
        entity, topic = _entity_from_session_state(recent)
        assert entity == "Valid"


# ---------------------------------------------------------------------------
# _entity_from_conversation_history — fallback extraction
# ---------------------------------------------------------------------------


class TestEntityFromConversationHistory:
    def test_extracts_entity_and_topic(self):
        ctx = {
            "conversation_history": [
                {"role": "user", "content": "what year was he on the masked singer"},
                {"role": "assistant", "content": "Corey Feldman was on The Masked Singer in 2024."},
            ]
        }
        entity, topic = _entity_from_conversation_history(ctx)
        assert entity == "Corey Feldman"
        assert topic == "The Masked Singer"

    def test_extracts_from_user_question(self):
        ctx = {"conversation_history": [{"role": "user", "content": "who is Alan Turing"}]}
        entity, topic = _entity_from_conversation_history(ctx)
        assert entity == "Alan Turing"

    def test_empty_history(self):
        entity, topic = _entity_from_conversation_history({})
        assert entity == ""
        assert topic == ""


# ---------------------------------------------------------------------------
# _resolve_entity_and_topic — combined resolution
# ---------------------------------------------------------------------------


class TestResolveEntityAndTopic:
    def test_session_state_preferred_over_history(self):
        ctx = {
            "recent_entities": [
                {"name": "Corey Feldman", "type": "person"},
                {"name": "The Masked Singer", "type": "topic"},
            ],
            "conversation_history": [
                {"role": "assistant", "content": "Marie Curie was a physicist."},
            ],
        }
        entity, topic = _resolve_entity_and_topic(ctx)
        assert entity == "Corey Feldman"
        assert topic == "The Masked Singer"

    def test_falls_back_to_history_when_no_session_state(self):
        ctx = {
            "conversation_history": [
                {"role": "assistant", "content": "Corey Feldman is an American actor."},
            ],
        }
        entity, topic = _resolve_entity_and_topic(ctx)
        assert entity == "Corey Feldman"

    def test_topic_from_history_when_session_has_entity_only(self):
        ctx = {
            "recent_entities": [{"name": "Corey Feldman", "type": "person"}],
            "conversation_history": [
                {"role": "user", "content": "what year was he on the masked singer"},
                {"role": "assistant", "content": "He appeared on the show in 2024."},
            ],
        }
        entity, topic = _resolve_entity_and_topic(ctx)
        assert entity == "Corey Feldman"
        assert "masked singer" in topic.lower()

    def test_empty_context(self):
        entity, topic = _resolve_entity_and_topic({})
        assert entity == ""
        assert topic == ""


# ---------------------------------------------------------------------------
# _extract_user_topic
# ---------------------------------------------------------------------------


class TestExtractUserTopic:
    def test_masked_singer_question(self):
        result = _extract_user_topic(
            "what year was he on the masked singer", "Corey Feldman"
        )
        assert "masked singer" in result.lower()

    def test_no_topic_when_only_entity(self):
        result = _extract_user_topic("who is Corey Feldman", "Corey Feldman")
        assert result == ""

    def test_empty_input(self):
        assert _extract_user_topic("", "Anything") == ""

    def test_short_residue_ignored(self):
        assert _extract_user_topic("is he ok", "Bob") == ""


# ---------------------------------------------------------------------------
# resolve_antecedents — full integration
# ---------------------------------------------------------------------------


class TestResolveAntecedents:
    def test_session_state_entity_resolution(self):
        """Uses session-state entities (the designed path)."""
        chunks = [RequestChunk(text="did he win", index=0, role="primary_request")]
        ctx = {
            "recent_entities": [
                {"name": "Corey Feldman", "type": "person"},
                {"name": "The Masked Singer", "type": "topic"},
            ],
        }
        resolved = resolve_antecedents(chunks, ctx)
        assert resolved[0].text == "did Corey Feldman win"
        assert ctx["conversation_topic"] == "The Masked Singer"

    def test_conversation_history_fallback(self):
        """Falls back to conversation history when session state is empty."""
        chunks = [RequestChunk(text="what year was he on the masked singer", index=0, role="primary_request")]
        ctx = {
            "conversation_history": [
                {"role": "user", "content": "who is corey feldman"},
                {"role": "assistant", "content": "Corey Feldman is an American actor, activist, and musician."},
            ]
        }
        resolved = resolve_antecedents(chunks, ctx)
        assert resolved[0].text == "what year was Corey Feldman on the masked singer"

    def test_did_he_win_with_history_fallback(self):
        """The reported bug scenario via conversation history fallback."""
        chunks = [RequestChunk(text="did he win", index=0, role="primary_request")]
        ctx = {
            "conversation_history": [
                {"role": "user", "content": "what year was he on the masked singer"},
                {"role": "assistant", "content": "Corey Feldman was on The Masked Singer in 2024, where he performed as 'Seal.'"},
            ]
        }
        resolved = resolve_antecedents(chunks, ctx)
        assert resolved[0].text == "did Corey Feldman win"
        assert "The Masked Singer" in ctx.get("conversation_topic", "")

    def test_possessive_followup(self):
        chunks = [RequestChunk(text="what is his birthday", index=0, role="primary_request")]
        ctx = {
            "recent_entities": [{"name": "Corey Feldman", "type": "person"}],
        }
        resolved = resolve_antecedents(chunks, ctx)
        assert resolved[0].text == "what is Corey Feldman's birthday"

    def test_no_context_no_change(self):
        chunks = [RequestChunk(text="what year was he born", index=0, role="primary_request")]
        resolved = resolve_antecedents(chunks, {})
        assert resolved[0].text == "what year was he born"

    def test_preserves_chunk_metadata(self):
        chunks = [RequestChunk(text="tell me about her", index=3, role="primary_request", span_start=10, span_end=27)]
        ctx = {
            "recent_entities": [{"name": "Marie Curie", "type": "person"}],
        }
        resolved = resolve_antecedents(chunks, ctx)
        assert resolved[0].index == 3
        assert resolved[0].role == "primary_request"
        assert resolved[0].span_start == 10
        assert resolved[0].span_end == 27


# ---------------------------------------------------------------------------
# Legacy text helpers
# ---------------------------------------------------------------------------


class TestFirstNounPhrase:
    def test_proper_noun(self):
        assert _first_noun_phrase("Corey Feldman is an American actor.") == "Corey Feldman"

    def test_single_word(self):
        assert _first_noun_phrase("Avatar is a movie.") == "Avatar"

    def test_no_caps(self):
        assert _first_noun_phrase("the weather is sunny.") == ""


class TestQuestionObject:
    def test_who_is(self):
        assert _question_object("who is Corey Feldman") == "Corey Feldman"

    def test_what_is(self):
        assert _question_object("what is Python") == "Python"

    def test_tell_me_about(self):
        assert _question_object("tell me about machine learning") == "machine learning"

    def test_no_match(self):
        assert _question_object("how do you spell restaurant") == ""
