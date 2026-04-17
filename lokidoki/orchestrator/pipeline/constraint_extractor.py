"""spaCy Matcher-based constraint extraction.

Detects budget, time, comparison, recommendation, negation, and quantity
signals from user input. These structured constraints feed into routing
priors and synthesis response shaping.

Uses the already-parsed spaCy ``Doc`` from the parser — no second model
call. Falls back to an empty ``ConstraintResult`` when spaCy is
unavailable.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from lokidoki.orchestrator.core.types import ConstraintResult

logger = logging.getLogger("lokidoki.orchestrator.pipeline.constraint_extractor")

# Budget pattern: "$" followed by a number, with optional decimal.
_BUDGET_RE = re.compile(
    r"(?:under|less\s+than|below|up\s+to|max(?:imum)?|at\s+most)?\s*"
    r"\$\s?(\d+(?:[.,]\d+)?)",
    re.IGNORECASE,
)

# Fallback for "under 500 dollars" / "below 100 bucks" style.
_BUDGET_WORDS_RE = re.compile(
    r"(?:under|less\s+than|below|up\s+to|max(?:imum)?|at\s+most)\s+"
    r"(\d+(?:[.,]\d+)?)\s*(?:dollars?|bucks?|usd)",
    re.IGNORECASE,
)

_COMPARISON_TOKENS = frozenset({
    "vs", "versus", "compare", "compared", "comparing", "better", "worse",
    "faster", "slower", "cheaper", "pricier",
})

_COMPARISON_PHRASES = (
    "compared to",
    "how does",
    "how do",
    "difference between",
    "which is better",
    "which one",
)

_RECOMMENDATION_TOKENS = frozenset({
    "best", "recommend", "recommended", "recommendation",
    "suggest", "suggested", "suggestion", "top", "favorite",
})

_RECOMMENDATION_PHRASES = (
    "should i",
    "which should",
    "what should",
    "which is the best",
    "what is the best",
    "what are the best",
)

_NEGATION_TOKENS = frozenset({
    "not", "n't", "no", "never", "without", "none",
})


def extract_constraints(doc: Any | None, text: str) -> ConstraintResult:
    """Extract structured constraints from parsed input.

    Parameters
    ----------
    doc:
        The spaCy ``Doc`` produced by ``parse_text``. May be ``None`` when
        spaCy is unavailable — in that case we return defaults.
    text:
        The cleaned user input string (used for regex fallbacks).
    """
    if doc is None:
        return ConstraintResult()

    budget = _extract_budget(doc, text)
    time_constraint = _extract_time_constraint(doc)
    is_comparison = _detect_comparison(doc, text)
    is_recommendation = _detect_recommendation(doc, text)
    negations = _extract_negations(doc)
    quantity = _extract_quantity(doc)

    return ConstraintResult(
        budget_max=budget,
        time_constraint=time_constraint,
        is_comparison=is_comparison,
        is_recommendation=is_recommendation,
        negations=negations,
        quantity=quantity,
    )


def _extract_budget(doc: Any, text: str) -> float | None:
    """Detect budget constraints like 'under $500' or '$100'."""
    # Check MONEY entities first — spaCy NER is more reliable.
    for ent in doc.ents:
        if ent.label_ == "MONEY":
            # Look for a budget-capping preposition before the entity.
            preceding = text[:ent.start_char].lower().strip()
            if any(preceding.endswith(w) for w in ("under", "below", "less than", "up to", "at most", "maximum", "max")):
                return _parse_money(ent.text)
            # Bare "$500" without a preceding capper — still useful as a budget signal.
            return _parse_money(ent.text)

    # Regex fallback for patterns spaCy misses.
    for pattern in (_BUDGET_RE, _BUDGET_WORDS_RE):
        match = pattern.search(text)
        if match:
            return _parse_number(match.group(1))

    return None


def _parse_money(money_text: str) -> float | None:
    """Parse a money string like '$500', '$1,200.50' into a float."""
    cleaned = re.sub(r"[^\d.,]", "", money_text)
    return _parse_number(cleaned)


def _parse_number(num_str: str) -> float | None:
    """Parse a number string, handling commas."""
    try:
        return float(num_str.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def _extract_time_constraint(doc: Any) -> str | None:
    """Detect time constraints like 'before 8pm', 'by Friday'."""
    time_preps = {"before", "by", "until", "after", "at"}

    for ent in doc.ents:
        if ent.label_ in ("TIME", "DATE"):
            # Check for a preceding preposition.
            if ent.start > 0:
                prev_token = doc[ent.start - 1]
                if prev_token.lower_ in time_preps:
                    return f"{prev_token.lower_} {ent.text}"
            return ent.text

    # Token-level fallback: look for time-prep + token patterns.
    for i, token in enumerate(doc):
        if token.lower_ in time_preps and i + 1 < len(doc):
            next_token = doc[i + 1]
            # Check if next token looks like a time (contains digits or
            # is a day/time word).
            if next_token.like_num or next_token.pos_ in ("NUM", "PROPN"):
                span_end = i + 2
                # Grab "8 pm" style spans.
                while span_end < len(doc) and doc[span_end].lower_ in (
                    "am", "pm", "a.m.", "p.m.", "o'clock",
                ):
                    span_end += 1
                return doc[i:span_end].text

    return None


def _detect_comparison(doc: Any, text: str) -> bool:
    """Detect comparison intent: 'vs', 'compared to', two entities + 'or'."""
    lower = text.lower()

    # Phrase-level check.
    if any(phrase in lower for phrase in _COMPARISON_PHRASES):
        return True

    # Token-level check.
    for token in doc:
        if token.lower_ in _COMPARISON_TOKENS:
            return True

    # Two entities joined by "or".
    ents = list(doc.ents)
    if len(ents) >= 2:
        for i in range(len(ents) - 1):
            between = text[ents[i].end_char:ents[i + 1].start_char].strip().lower()
            if between in ("or", "vs", "vs.", "versus", "and"):
                return True

    return False


def _detect_recommendation(doc: Any, text: str) -> bool:
    """Detect recommendation-seeking: 'best', 'should I', 'recommend'."""
    lower = text.lower()

    if any(phrase in lower for phrase in _RECOMMENDATION_PHRASES):
        return True

    for token in doc:
        if token.lower_ in _RECOMMENDATION_TOKENS:
            return True

    return False


def _extract_negations(doc: Any) -> list[str]:
    """Extract negated phrases: 'not too technical' -> 'too technical'."""
    negations: list[str] = []

    for i, token in enumerate(doc):
        if token.lower_ in _NEGATION_TOKENS or token.text.endswith("n't"):
            # Collect the rest of the phrase until punctuation or clause boundary.
            phrase_tokens: list[str] = []
            for j in range(i + 1, min(i + 6, len(doc))):
                next_tok = doc[j]
                if next_tok.pos_ in ("PUNCT", "CCONJ", "SCONJ") or next_tok.is_sent_start:
                    break
                phrase_tokens.append(next_tok.text)
            if phrase_tokens:
                negations.append(" ".join(phrase_tokens))

    return negations


def _extract_quantity(doc: Any) -> str | None:
    """Detect quantity patterns: '3 tickets', 'how many'."""
    # "how many" / "how much" patterns.
    for i, token in enumerate(doc):
        if token.lower_ == "how" and i + 1 < len(doc):
            next_lower = doc[i + 1].lower_
            if next_lower in ("many", "much"):
                return doc[i:i + 2].text

    # Cardinal + noun: "3 tickets", "five items".
    for token in doc:
        if token.pos_ == "NUM" and token.head.pos_ in ("NOUN", "PROPN"):
            return f"{token.text} {token.head.text}"

    return None
