"""Sanity coverage for the centralized English linguistic constants."""
from __future__ import annotations

from v2.orchestrator.linguistics import (
    CONNECTORS,
    DETERMINERS,
    FINITE_AUX,
    INTERJECTIONS,
    NUMBER_WORDS,
    PRONOUNS,
    SUBORDINATORS,
    WH_WORDS,
    WORD_OPERATORS,
)


def test_linguistics_pronouns_cover_third_person_set():
    for pronoun in ("he", "she", "it", "they", "him", "her", "them"):
        assert pronoun in PRONOUNS


def test_linguistics_determiners_cover_definite_set():
    for det in ("the", "this", "that", "these", "those"):
        assert det in DETERMINERS


def test_linguistics_wh_words_cover_question_starters():
    for wh in ("what", "when", "where", "how", "why", "who", "which"):
        assert wh in WH_WORDS


def test_linguistics_subordinators_cover_common_clause_markers():
    for marker in ("because", "since", "if", "while", "although"):
        assert marker in SUBORDINATORS


def test_linguistics_connectors_drop_compound_utterances_in_fast_lane():
    # Each entry must be padded so substring containment is unambiguous.
    for connector in CONNECTORS:
        assert connector.startswith(" ") and connector.endswith(" ")


def test_linguistics_finite_aux_recognizes_copula_and_modals():
    for verb in ("is", "was", "do", "have", "can", "should"):
        assert verb in FINITE_AUX


def test_linguistics_interjections_treated_as_speech_acts():
    for word in ("hello", "thanks", "yes", "no"):
        assert word in INTERJECTIONS


def test_linguistics_number_words_cover_one_to_twenty():
    for word, expected in {"one": 1, "ten": 10, "twenty": 20, "hundred": 100}.items():
        assert NUMBER_WORDS[word] == expected


def test_linguistics_word_operators_map_to_arithmetic_symbols():
    assert WORD_OPERATORS["plus"] == "+"
    assert WORD_OPERATORS["times"] == "*"
    assert WORD_OPERATORS["divided"] == "/"
    assert WORD_OPERATORS["x"] == "*"
