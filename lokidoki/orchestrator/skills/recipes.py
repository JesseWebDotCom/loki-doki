"""recipes adapter — wraps lokidoki.skills.recipes.

The RecipeMealDBSkill exposes a single ``themealdb`` mechanism that
takes a query (recipe name or ingredient) and returns up to three
matching recipes with shaped ingredients/instructions.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.recipes.skill import RecipeMealDBSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = RecipeMealDBSkill()

_LEAD_VERBS = (
    "recipe for ",
    "how do i make ",
    "how do you make ",
    "how to make ",
    "show me a recipe for ",
    "find me a recipe for ",
    "give me a recipe for ",
)


def _extract_query(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not text:
        return ""
    for verb in _LEAD_VERBS:
        if text.startswith(verb):
            return text[len(verb):].strip()
    return text


def _format_success(result, method: str) -> str:
    data = result.data or {}
    query = data.get("query") or "your recipe"
    recipes = data.get("recipes") or []
    if not recipes:
        return f"I couldn't find a recipe for {query}."
    first = recipes[0]
    name = first.get("name") or "an untitled recipe"
    ingredients = first.get("ingredients") or []
    if ingredients:
        joined = ", ".join(ingredients[:5])
        return f"Recipe found: {name}. Key ingredients: {joined}."
    return f"Recipe found: {name}."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    query = _extract_query(payload)
    if not query:
        return AdapterResult(
            output_text="What dish would you like a recipe for?",
            success=False,
            error="missing query",
        ).to_payload()
    attempts = [("themealdb", {"query": query})]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=f"I couldn't reach TheMealDB to look up '{query}'.",
    )
    return result.to_payload()
