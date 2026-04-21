"""Response adapter for TheMealDB recipe payloads."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


_MEALDB_BASE = "https://www.themealdb.com"


class RecipeMealDBAdapter:
    skill_id = "recipes"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        recipes = data.get("recipes") or []
        if not isinstance(recipes, list) or not recipes:
            return AdapterOutput(raw=data)

        first = recipes[0] if isinstance(recipes[0], dict) else {}
        name = str(first.get("name") or "").strip()
        if not name:
            return AdapterOutput(raw=data)

        area = str(first.get("area") or "").strip()
        category = str(first.get("category") or "").strip()
        description_bits: list[str] = []
        if category:
            description_bits.append(category)
        if area:
            description_bits.append(area)
        descriptor = " · ".join(description_bits)
        summary = f"{name} — {descriptor}" if descriptor else name

        ingredients_raw = first.get("ingredients") or []
        ingredients: list[str] = []
        if isinstance(ingredients_raw, list):
            for item in ingredients_raw[:12]:
                text = str(item or "").strip()
                if text:
                    ingredients.append(text)

        facts: list[str] = []
        if ingredients:
            facts.append("Ingredients: " + ", ".join(ingredients))
        if category:
            facts.append(f"Cuisine: {area or category}")

        source_url = str(first.get("source") or "").strip() or _MEALDB_BASE
        sources = (
            Source(
                title=f"MealDB: {name}",
                url=source_url or None,
                kind="web",
                snippet=descriptor or None,
            ),
        )

        actions: tuple[dict, ...] = ()
        recipe_id = first.get("id") or first.get("meal_id")
        if recipe_id:
            actions = ({"kind": "print_recipe", "recipe_id": recipe_id},)

        return AdapterOutput(
            summary_candidates=(summary,),
            facts=tuple(facts),
            sources=sources,
            actions=actions,
            raw=data,
        )
