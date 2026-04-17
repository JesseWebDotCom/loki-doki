"""Tests for spaCy-based constraint extraction."""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import ConstraintResult
from lokidoki.orchestrator.pipeline.constraint_extractor import extract_constraints

try:
    import spacy
    _nlp = spacy.load("en_core_web_sm")
except Exception:
    _nlp = None

pytestmark = pytest.mark.skipif(_nlp is None, reason="spaCy en_core_web_sm not available")


def _extract(text: str) -> ConstraintResult:
    """Helper: parse text with spaCy and extract constraints."""
    doc = _nlp(text)
    return extract_constraints(doc, text)


# --- Budget -------------------------------------------------------------------

def test_budget_under_dollar_sign():
    result = _extract("best laptop under $500")
    assert result.budget_max == 500.0


def test_budget_bare_dollar():
    result = _extract("I need something for $200")
    assert result.budget_max == 200.0


def test_budget_less_than():
    result = _extract("find me a phone less than $300")
    assert result.budget_max == 300.0


# --- Time constraint ----------------------------------------------------------

def test_time_before():
    result = _extract("I need it before 8pm")
    assert result.time_constraint is not None
    assert "8" in result.time_constraint


def test_time_by_friday():
    result = _extract("finish this by Friday")
    assert result.time_constraint is not None


# --- Comparison ---------------------------------------------------------------

def test_comparison_vs():
    result = _extract("compare phi4 vs gemma 4")
    assert result.is_comparison is True


def test_comparison_better():
    result = _extract("which one is better for gaming")
    assert result.is_comparison is True


def test_comparison_compared_to():
    result = _extract("how does Python compare compared to JavaScript")
    assert result.is_comparison is True


# --- Recommendation -----------------------------------------------------------

def test_recommendation_best():
    result = _extract("what is the best laptop under $500")
    assert result.is_recommendation is True
    assert result.budget_max == 500.0


def test_recommendation_should_i():
    result = _extract("should I buy a MacBook or a ThinkPad")
    assert result.is_recommendation is True


def test_recommendation_recommend():
    result = _extract("can you recommend a good book")
    assert result.is_recommendation is True


# --- Negation -----------------------------------------------------------------

def test_negation_not_too():
    result = _extract("not too technical")
    assert len(result.negations) >= 1
    assert any("too technical" in n for n in result.negations)


def test_negation_without():
    result = _extract("find a recipe without gluten")
    assert len(result.negations) >= 1
    assert any("gluten" in n for n in result.negations)


# --- Quantity -----------------------------------------------------------------

def test_quantity_cardinal_noun():
    result = _extract("I need 3 tickets to the show")
    assert result.quantity is not None
    assert "3" in result.quantity


def test_quantity_how_many():
    result = _extract("how many planets are in the solar system")
    assert result.quantity is not None
    assert "how many" in result.quantity.lower()


# --- Combined / composite -----------------------------------------------------

def test_combined_budget_and_recommendation():
    """'best laptop under $500' should trigger both budget and recommendation."""
    result = _extract("best laptop under $500")
    assert result.budget_max == 500.0
    assert result.is_recommendation is True


def test_comparison_two_entities():
    result = _extract("compare phi4 and gemma 4")
    assert result.is_comparison is True


# --- No constraints (defaults) ------------------------------------------------

def test_plain_text_no_constraints():
    result = _extract("tell me about elephants")
    assert result.budget_max is None
    assert result.time_constraint is None
    assert result.is_comparison is False
    assert result.is_recommendation is False
    assert result.negations == []
    assert result.quantity is None


# --- Graceful degradation (no spaCy doc) --------------------------------------

def test_none_doc_returns_defaults():
    result = extract_constraints(None, "anything")
    assert result == ConstraintResult()
