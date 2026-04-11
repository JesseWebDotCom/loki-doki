"""Fast lane for the v2 prototype.

Bypasses the full pipeline for utterances that are unambiguously trivial:
greetings, acknowledgments, the bare clock query, the bare date query,
the spelling utility, and a small math utility. The fast lane runs
**before** the spaCy parse so it must stay cheap — pattern matching is
done with normalized lemmas + a fuzzy template match (rapidfuzz) over a
small curated set of canonical utterances.

Anything compound, contextual, or non-trivial falls through to the main
pipeline. The CLAUDE.md guard against keyword-classifying *user intent*
does not apply here: this is the spec-mandated trivial-utterance bypass,
gated by length, connector absence, and a hard fuzzy threshold.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any, Callable

try:  # rapidfuzz is in the project dependencies but isolate the import.
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover - exercised by hash-fallback path
    fuzz = None

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.core.types import FastLaneResult
from v2.orchestrator.linguistics import CONNECTORS, NUMBER_WORDS, WORD_OPERATORS

# Templates below are *fast-lane curated utterances*, not English linguistic
# constants — they live here because they describe what counts as a trivial
# bypassable utterance, which is fast-lane policy, not language data.
GREETINGS = (
    "hello",
    "hi",
    "hey",
    "hi there",
    "hello there",
    "hey there",
    "good morning",
    "good afternoon",
    "good evening",
    "yo",
)
ACKNOWLEDGMENTS = (
    "thanks",
    "thank you",
    "thanks a lot",
    "thanks so much",
    "thank you so much",
    "got it",
    "appreciate it",
    "ok thanks",
)
TIME_TEMPLATES = (
    "what time is it",
    "what's the time",
    "what is the time",
    "tell me the time",
    "do you have the time",
    "current time",
)
DATE_TEMPLATES = (
    "what day is it",
    "what's the date",
    "what is today's date",
    "what's today's date",
    "what day of the week is it",
    "what is today",
)
SPELL_PATTERN = re.compile(r"^(?:how (?:do you|would you) )?spell (?P<word>[a-zA-Z][a-zA-Z\-']*)$")
PERCENT_PATTERN = re.compile(
    r"^(?P<n>\d+(?:\.\d+)?)\s*(?:percent|%)\s*of\s*(?P<m>\d+(?:\.\d+)?)$"
)


def check_fast_lane(cleaned_text: str) -> FastLaneResult:
    """Return a direct response when the utterance is trivial; else fall through."""
    lemma = _normalize(cleaned_text)
    if not lemma:
        return FastLaneResult(matched=False, reason="empty")
    if any(connector in f" {lemma} " for connector in CONNECTORS):
        return FastLaneResult(matched=False, reason="compound")
    if len(lemma.split()) > CONFIG.fast_lane_max_tokens:
        return FastLaneResult(matched=False, reason="too_long")

    matchers: tuple[Callable[[str], FastLaneResult | None], ...] = (
        _match_greeting,
        _match_acknowledgment,
        _match_time,
        _match_date,
        _match_spelling,
        _match_math,
    )
    for matcher in matchers:
        result = matcher(lemma)
        if result is not None:
            return result
    return FastLaneResult(matched=False, reason="no_match")


def _normalize(raw: str) -> str:
    text = unicodedata.normalize("NFKC", raw or "")
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.lower().strip()
    text = re.sub(r"[?!.,]+$", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _fuzzy_hit(candidate: str, templates: tuple[str, ...]) -> bool:
    if candidate in templates:
        return True
    if fuzz is None:
        return False
    threshold = CONFIG.fast_lane_fuzzy_threshold
    return any(fuzz.ratio(candidate, template) >= threshold for template in templates)


def _match_greeting(lemma: str) -> FastLaneResult | None:
    if not _fuzzy_hit(lemma, GREETINGS):
        return None
    return FastLaneResult(
        matched=True,
        capability="greeting_response",
        response_text="Hello.",
    )


def _match_acknowledgment(lemma: str) -> FastLaneResult | None:
    if not _fuzzy_hit(lemma, ACKNOWLEDGMENTS):
        return None
    return FastLaneResult(
        matched=True,
        capability="acknowledgment_response",
        response_text="You're welcome.",
    )


def _match_time(lemma: str) -> FastLaneResult | None:
    if not _fuzzy_hit(lemma, TIME_TEMPLATES):
        return None
    return FastLaneResult(
        matched=True,
        capability="get_current_time",
        response_text=datetime.now().strftime("%-I:%M %p"),
    )


def _match_date(lemma: str) -> FastLaneResult | None:
    if not _fuzzy_hit(lemma, DATE_TEMPLATES):
        return None
    return FastLaneResult(
        matched=True,
        capability="get_current_date",
        response_text=datetime.now().strftime("%A, %B %-d, %Y"),
    )


def _match_spelling(lemma: str) -> FastLaneResult | None:
    match = SPELL_PATTERN.match(lemma)
    if not match:
        return None
    word = match.group("word").strip()
    if not word:
        return None
    return FastLaneResult(
        matched=True,
        capability="spell_word",
        response_text=word,
    )


def _match_math(lemma: str) -> FastLaneResult | None:
    expression = _extract_math_expression(lemma)
    if not expression:
        return None
    try:
        value = _safe_eval(expression)
    except Exception:
        return None
    rendered = _format_number(value)
    return FastLaneResult(
        matched=True,
        capability="calculate_math",
        response_text=rendered,
    )


def _extract_math_expression(lemma: str) -> str | None:
    stripped = lemma
    for prefix in ("what is ", "what's ", "whats ", "calculate ", "compute "):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            break
    else:
        return None
    stripped = stripped.strip()
    if not stripped:
        return None

    percent_match = PERCENT_PATTERN.match(stripped)
    if percent_match:
        n = float(percent_match.group("n"))
        m = float(percent_match.group("m"))
        return f"({n} / 100) * {m}"

    tokens: list[str] = []
    for raw_token in stripped.replace("?", "").split():
        token = raw_token.strip().lower()
        if not token:
            continue
        if token in WORD_OPERATORS:
            replacement = WORD_OPERATORS[token]
            if replacement:
                tokens.append(replacement)
            continue
        if token in NUMBER_WORDS:
            tokens.append(str(NUMBER_WORDS[token]))
            continue
        tokens.append(token)
    expression = " ".join(tokens)
    if not re.fullmatch(r"[\d+\-*/().\s]+", expression):
        return None
    return expression


def _safe_eval(expression: str) -> float:
    import ast

    node = ast.parse(expression, mode="eval")
    allowed = (
        ast.Expression,
        ast.BinOp,
        ast.UnaryOp,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.Mod,
        ast.Pow,
        ast.USub,
        ast.UAdd,
        ast.Constant,
    )
    for item in ast.walk(node):
        if not isinstance(item, allowed):
            raise ValueError("unsupported math expression")
    return float(eval(compile(node, "<fast-lane-math>", "eval"), {"__builtins__": {}}, {}))


def _format_number(value: float) -> str:
    if value != value:  # NaN
        raise ValueError("nan result")
    if value.is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")
