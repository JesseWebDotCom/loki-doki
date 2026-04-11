"""Fast-lane rules and direct utilities for the v2 prototype."""
from __future__ import annotations

import ast
from datetime import datetime

from v2.bmo_nlu.core.types import FastLaneResult

CONNECTORS = (" because ", " and ", " if ", " so that ", " but ", " also ")
GREETINGS = {"hello", "hi", "hey", "hi there", "hello there"}
ACKS = {"thanks", "thank you", "got it"}


def _safe_eval_math(expression: str) -> float:
    node = ast.parse(expression, mode="eval")
    allowed_nodes = (
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
        if not isinstance(item, allowed_nodes):
            raise ValueError("unsupported math expression")
    return float(eval(compile(node, "<fast-lane-math>", "eval"), {"__builtins__": {}}, {}))


def check_fast_lane(cleaned_text: str) -> FastLaneResult:
    """Return a direct utility response when the whole utterance is trivial."""
    lower = cleaned_text.lower().strip()
    if not lower:
        return FastLaneResult(matched=False, reason="empty")
    if any(connector in f" {lower} " for connector in CONNECTORS):
        return FastLaneResult(matched=False, reason="compound")
    if len(lower.split()) > 8:
        return FastLaneResult(matched=False, reason="too_long")
    if lower in GREETINGS:
        return FastLaneResult(matched=True, capability="greeting_response", response_text="Hello.")
    if lower in ACKS:
        return FastLaneResult(matched=True, capability="acknowledgment_response", response_text="You're welcome.")
    if lower in {"what time is it", "what's the time"}:
        return FastLaneResult(
            matched=True,
            capability="get_current_time",
            response_text=datetime.now().strftime("%-I:%M %p"),
        )
    if lower in {"what day is it", "what's today's date", "what is today's date"}:
        return FastLaneResult(
            matched=True,
            capability="get_current_date",
            response_text=datetime.now().strftime("%A, %B %-d, %Y"),
        )
    if lower.startswith("how do you spell "):
        word = cleaned_text[len("how do you spell "):].strip()
        if word:
            return FastLaneResult(matched=True, capability="spell_word", response_text=word)
    if lower.startswith("spell "):
        word = cleaned_text[len("spell "):].strip()
        if word:
            return FastLaneResult(matched=True, capability="spell_word", response_text=word)
    if lower.startswith("what is "):
        expression = lower[len("what is "):].replace("x", "*")
        try:
            value = _safe_eval_math(expression)
        except (SyntaxError, ValueError, TypeError, ZeroDivisionError):
            return FastLaneResult(matched=False, reason="not_math")
        if value.is_integer():
            rendered = str(int(value))
        else:
            rendered = str(round(value, 4)).rstrip("0").rstrip(".")
        return FastLaneResult(matched=True, capability="calculate_math", response_text=rendered)
    return FastLaneResult(matched=False, reason="no_match")
