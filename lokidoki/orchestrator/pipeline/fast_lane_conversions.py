"""Unit conversion tables and handlers for the fast lane.

Closed lookup tables — these are physical constants, not project config.
Adding a new conversion is a one-line table edit, no rule code needed.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.orchestrator.core.types import FastLaneResult

# ---- unit aliases ------------------------------------------------------------

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

# Direct ratios for unit pairs that don't fit the (smaller, larger) frame.
# ``_RATIOS_DIRECT[(from, to)] = factor`` such that
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


def _format_number(value: float) -> str:
    if value != value:  # NaN
        raise ValueError("nan result")
    if value.is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def match_unit_conversion(lemma: str) -> FastLaneResult | None:
    """Match common unit-conversion utterances and return a deterministic answer."""
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
    direct = _UNIT_RATIOS.get((canonical_to, canonical_from))
    if direct is not None:
        result = amount * direct
        return f"{_format_number(result)} {_pluralize(canonical_to, result)}"
    inverse = _UNIT_RATIOS.get((canonical_from, canonical_to))
    if inverse is not None:
        result = amount / inverse
        return f"{_format_number(result)} {_pluralize(canonical_to, result)}"
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
