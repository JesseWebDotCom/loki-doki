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
SPELL_PATTERN = re.compile(
    r"^(?:how (?:do you|do i|would you|would i) )?spell (?P<word>[a-zA-Z][a-zA-Z\-']*)$"
)
PERCENT_PATTERN = re.compile(
    r"^(?P<n>\d+(?:\.\d+)?)\s*(?:percent|%)\s*of\s*(?P<m>\d+(?:\.\d+)?)$"
)

# ---- unit conversion (fast lane) --------------------------------------------
#
# Closed lookup tables — these are physical constants, not project config.
# Adding a new conversion is a one-line table edit, no rule code needed.

_UNIT_ALIASES: dict[str, str] = {
    # volume — US customary
    "gallon": "gallon", "gallons": "gallon", "gal": "gallon",
    "quart": "quart", "quarts": "quart", "qt": "quart", "qts": "quart",
    "pint": "pint", "pints": "pint", "pt": "pint", "pts": "pint",
    "cup": "cup", "cups": "cup",
    # volume — metric
    "liter": "liter", "liters": "liter", "litre": "liter", "litres": "liter", "l": "liter",
    # length — US customary
    "mile": "mile", "miles": "mile", "mi": "mile",
    "yard": "yard", "yards": "yard", "yd": "yard", "yds": "yard",
    "foot": "foot", "feet": "foot", "ft": "foot",
    "inch": "inch", "inches": "inch", "in": "inch",
    # length — metric
    "kilometer": "kilometer", "kilometers": "kilometer", "kilometre": "kilometer",
    "kilometres": "kilometer", "km": "kilometer", "kms": "kilometer",
    "meter": "meter", "meters": "meter", "metre": "meter", "metres": "meter", "m": "meter",
    "centimeter": "centimeter", "centimeters": "centimeter",
    "centimetre": "centimeter", "centimetres": "centimeter", "cm": "centimeter",
    # mass — US customary
    "pound": "pound", "pounds": "pound", "lb": "pound", "lbs": "pound",
    "ounce": "ounce", "ounces": "ounce", "oz": "ounce",
    # mass — metric
    "kilogram": "kilogram", "kilograms": "kilogram", "kg": "kilogram", "kgs": "kilogram",
    "gram": "gram", "grams": "gram", "g": "gram",
}

# (smaller_unit, larger_unit) -> count of smaller in one larger.
_UNIT_RATIOS: dict[tuple[str, str], float] = {
    # volume — US customary
    ("quart", "gallon"): 4,
    ("pint", "gallon"): 8,
    ("cup", "gallon"): 16,
    ("pint", "quart"): 2,
    ("cup", "quart"): 4,
    ("cup", "pint"): 2,
    # length — US customary
    ("foot", "mile"): 5280,
    ("yard", "mile"): 1760,
    ("inch", "mile"): 63360,
    ("inch", "foot"): 12,
    ("foot", "yard"): 3,
    ("inch", "yard"): 36,
    # length — metric
    ("meter", "kilometer"): 1000,
    ("centimeter", "meter"): 100,
    ("centimeter", "kilometer"): 100000,
    # length — cross-system (US ↔ metric)
    ("meter", "mile"): 1609.344,
    ("centimeter", "mile"): 160934.4,
    ("centimeter", "foot"): 30.48,
    ("centimeter", "inch"): 2.54,
    ("centimeter", "yard"): 91.44,
    ("meter", "yard"): 0.9144,
    # mass — US customary
    ("ounce", "pound"): 16,
}

# Direct ratios for unit pairs that don't fit the (smaller, larger) frame —
# typically when the relationship is fractional both ways and we want a
# friendlier reading. ``_RATIOS_DIRECT[(from, to)] = factor`` such that
# ``to_amount = from_amount * factor``.
_RATIOS_DIRECT: dict[tuple[str, str], float] = {
    ("mile", "kilometer"): 1.609344,
    ("kilometer", "mile"): 0.621371,
    ("pound", "kilogram"): 0.453592,
    ("kilogram", "pound"): 2.20462,
    ("gallon", "liter"): 3.78541,
    ("liter", "gallon"): 0.264172,
    ("ounce", "gram"): 28.3495,
    ("gram", "ounce"): 0.035274,
}

_TEMP_ALIASES: dict[str, str] = {
    "f": "f", "fahrenheit": "f",
    "c": "c", "celsius": "c", "celcius": "c",  # accept common misspelling
}

# "how many quarts in (a/an/one)? gallon" / "how many feet in 2 miles"
_HOW_MANY_PATTERN = re.compile(
    r"^how many (?P<small>[a-z]+) (?:are )?in (?:a |an |one |1 )?(?P<n>\d+(?:\.\d+)?\s+)?(?P<large>[a-z]+)s?$"
)

# "convert 5 miles to feet"
_CONVERT_PATTERN = re.compile(
    r"^convert (?P<n>\d+(?:\.\d+)?) (?P<from>[a-z]+) (?:to|into) (?P<to>[a-z]+)$"
)

# "72 (degrees)? f (is how much)? in/to (degrees)? c"  (and reverse)
_TEMP_PATTERN = re.compile(
    r"^(?P<n>-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?(?P<from>fahrenheit|celsius|celcius|f|c)"
    r"\s+(?:is\s+how\s+much\s+)?(?:in|to)\s*(?:degrees?\s*)?"
    r"(?P<to>fahrenheit|celsius|celcius|f|c)$"
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
        _match_unit_conversion,
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


def _match_unit_conversion(lemma: str) -> FastLaneResult | None:
    """Match common unit-conversion utterances and return a deterministic answer."""
    # Temperature first — its grammar overlaps with "X is how much in Y".
    temp = _try_temperature(lemma)
    if temp is not None:
        return temp

    convert_match = _CONVERT_PATTERN.match(lemma)
    if convert_match:
        result = _ratio_convert(
            float(convert_match.group("n")),
            convert_match.group("from"),
            convert_match.group("to"),
        )
        if result is not None:
            return FastLaneResult(
                matched=True,
                capability="convert_units",
                response_text=result,
            )

    how_many_match = _HOW_MANY_PATTERN.match(lemma)
    if how_many_match:
        n_text = (how_many_match.group("n") or "").strip()
        n = float(n_text) if n_text else 1.0
        result = _ratio_convert(
            n,
            how_many_match.group("large"),
            how_many_match.group("small"),
        )
        if result is not None:
            return FastLaneResult(
                matched=True,
                capability="convert_units",
                response_text=result,
            )

    return None


def _try_temperature(lemma: str) -> FastLaneResult | None:
    match = _TEMP_PATTERN.match(lemma)
    if not match:
        return None
    src = _TEMP_ALIASES.get(match.group("from"))
    dst = _TEMP_ALIASES.get(match.group("to"))
    if not src or not dst or src == dst:
        return None
    value = float(match.group("n"))
    if src == "f" and dst == "c":
        converted = (value - 32) * 5 / 9
        unit_label = "°C"
    else:
        converted = value * 9 / 5 + 32
        unit_label = "°F"
    return FastLaneResult(
        matched=True,
        capability="convert_units",
        response_text=f"{_format_number(round(converted, 2))}{unit_label}",
    )


def _ratio_convert(amount: float, from_unit: str, to_unit: str) -> str | None:
    """Convert ``amount`` from ``from_unit`` into ``to_unit`` using the table."""
    canonical_from = _UNIT_ALIASES.get(from_unit)
    canonical_to = _UNIT_ALIASES.get(to_unit)
    if not canonical_from or not canonical_to:
        return None
    if canonical_from == canonical_to:
        return f"{_format_number(amount)} {_pluralize(canonical_to, amount)}"
    # First try the (smaller, larger) ratio table.
    direct = _UNIT_RATIOS.get((canonical_to, canonical_from))
    if direct is not None:
        result = amount * direct
        return f"{_format_number(result)} {_pluralize(canonical_to, result)}"
    inverse = _UNIT_RATIOS.get((canonical_from, canonical_to))
    if inverse is not None:
        result = amount / inverse
        return f"{_format_number(result)} {_pluralize(canonical_to, result)}"
    # Fall through to the cross-system direct table (mile↔km, lb↔kg, ...).
    direct_factor = _RATIOS_DIRECT.get((canonical_from, canonical_to))
    if direct_factor is not None:
        result = amount * direct_factor
        return f"{_format_number(round(result, 4))} {_pluralize(canonical_to, result)}"
    return None


def _pluralize(unit: str, amount: float) -> str:
    """Return a basic plural form for the small set of supported units."""
    irregular = {"foot": "feet"}
    if amount == 1:
        return unit
    if unit in irregular:
        return irregular[unit]
    if unit.endswith("s"):
        return unit
    if unit == "inch":
        return "inches"
    return f"{unit}s"


def _format_number(value: float) -> str:
    if value != value:  # NaN
        raise ValueError("nan result")
    if value.is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")
