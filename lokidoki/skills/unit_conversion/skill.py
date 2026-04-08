"""Unit conversion skill — table-driven, offline."""
from __future__ import annotations

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

# Each category maps unit aliases -> conversion factor TO the canonical unit.
_LENGTH = {  # canonical: meter
    "m": 1.0, "meter": 1.0, "meters": 1.0, "metre": 1.0, "metres": 1.0,
    "km": 1000.0, "kilometer": 1000.0, "kilometers": 1000.0, "kilometre": 1000.0, "kilometres": 1000.0,
    "cm": 0.01, "centimeter": 0.01, "centimeters": 0.01,
    "mm": 0.001, "millimeter": 0.001, "millimeters": 0.001,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
    "ft": 0.3048, "foot": 0.3048, "feet": 0.3048,
    "yd": 0.9144, "yard": 0.9144, "yards": 0.9144,
    "mi": 1609.344, "mile": 1609.344, "miles": 1609.344,
    "nmi": 1852.0, "nauticalmile": 1852.0, "nauticalmiles": 1852.0,
}

_WEIGHT = {  # canonical: gram
    "g": 1.0, "gram": 1.0, "grams": 1.0,
    "kg": 1000.0, "kilogram": 1000.0, "kilograms": 1000.0,
    "mg": 0.001, "milligram": 0.001, "milligrams": 0.001,
    "lb": 453.59237, "lbs": 453.59237, "pound": 453.59237, "pounds": 453.59237,
    "oz": 28.349523125, "ounce": 28.349523125, "ounces": 28.349523125,
    "t": 1000000.0, "ton": 1000000.0, "tons": 1000000.0, "tonne": 1000000.0,
}

_VOLUME = {  # canonical: liter
    "l": 1.0, "liter": 1.0, "liters": 1.0, "litre": 1.0, "litres": 1.0,
    "ml": 0.001, "milliliter": 0.001, "milliliters": 0.001,
    "gal": 3.785411784, "gallon": 3.785411784, "gallons": 3.785411784,
    "qt": 0.946352946, "quart": 0.946352946, "quarts": 0.946352946,
    "pt": 0.473176473, "pint": 0.473176473, "pints": 0.473176473,
    "cup": 0.2365882365, "cups": 0.2365882365,
    "floz": 0.0295735295625, "fluidounce": 0.0295735295625, "fluidounces": 0.0295735295625,
    "tbsp": 0.01478676478125, "tablespoon": 0.01478676478125, "tablespoons": 0.01478676478125,
    "tsp": 0.00492892159375, "teaspoon": 0.00492892159375, "teaspoons": 0.00492892159375,
}

_TIME = {  # canonical: second
    "s": 1.0, "sec": 1.0, "second": 1.0, "seconds": 1.0,
    "ms": 0.001, "millisecond": 0.001, "milliseconds": 0.001,
    "min": 60.0, "minute": 60.0, "minutes": 60.0,
    "h": 3600.0, "hr": 3600.0, "hour": 3600.0, "hours": 3600.0,
    "d": 86400.0, "day": 86400.0, "days": 86400.0,
    "wk": 604800.0, "week": 604800.0, "weeks": 604800.0,
}

_CATEGORIES = {
    "length": _LENGTH,
    "weight": _WEIGHT,
    "volume": _VOLUME,
    "time": _TIME,
}

# Temperature handled separately because it's not a simple ratio.
_TEMP_ALIASES = {
    "c": "c", "celsius": "c", "centigrade": "c",
    "f": "f", "fahrenheit": "f",
    "k": "k", "kelvin": "k",
}


def _normalize_unit(u: str) -> str:
    return u.strip().lower().replace(".", "").replace(" ", "").rstrip("s") + ("s" if u.strip().lower().endswith("s") else "")


def _lookup(unit: str):
    u = unit.strip().lower().replace(".", "").replace(" ", "")
    for cat_name, table in _CATEGORIES.items():
        if u in table:
            return cat_name, table[u]
    return None, None


def _convert_temp(value: float, src: str, dst: str) -> float:
    src = _TEMP_ALIASES[src]
    dst = _TEMP_ALIASES[dst]
    # to Kelvin first
    if src == "c":
        k = value + 273.15
    elif src == "f":
        k = (value - 32.0) * 5.0 / 9.0 + 273.15
    else:
        k = value
    if dst == "c":
        return k - 273.15
    if dst == "f":
        return (k - 273.15) * 9.0 / 5.0 + 32.0
    return k


class UnitConversionSkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "table_lookup":
            raise ValueError(f"Unknown mechanism: {method}")
        try:
            value = float(parameters.get("value"))
        except (TypeError, ValueError):
            return MechanismResult(success=False, error="value must be a number")
        from_unit = str(parameters.get("from_unit") or "").strip()
        to_unit = str(parameters.get("to_unit") or "").strip()
        if not from_unit or not to_unit:
            return MechanismResult(success=False, error="from_unit and to_unit required")

        # Temperature special-case
        if from_unit.lower() in _TEMP_ALIASES and to_unit.lower() in _TEMP_ALIASES:
            result = _convert_temp(value, from_unit.lower(), to_unit.lower())
            return MechanismResult(
                success=True,
                data={
                    "value": value, "from_unit": from_unit, "to_unit": to_unit,
                    "result": round(result, 6), "category": "temperature",
                },
            )

        cat_a, factor_a = _lookup(from_unit)
        cat_b, factor_b = _lookup(to_unit)
        if cat_a is None or cat_b is None:
            return MechanismResult(success=False, error=f"unknown unit(s): {from_unit}, {to_unit}")
        if cat_a != cat_b:
            return MechanismResult(
                success=False,
                error=f"cannot convert {cat_a} ({from_unit}) to {cat_b} ({to_unit})",
            )
        result = value * factor_a / factor_b
        return MechanismResult(
            success=True,
            data={
                "value": value, "from_unit": from_unit, "to_unit": to_unit,
                "result": round(result, 6), "category": cat_a,
            },
        )
