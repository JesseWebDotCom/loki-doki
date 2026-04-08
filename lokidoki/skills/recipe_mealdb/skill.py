"""Recipe skill — TheMealDB free public API (test key '1' is the public key)."""
from __future__ import annotations

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

BASE = "https://www.themealdb.com/api/json/v1/1"


def _shape_meal(meal: dict) -> dict:
    ingredients = []
    for i in range(1, 21):
        name = (meal.get(f"strIngredient{i}") or "").strip()
        amount = (meal.get(f"strMeasure{i}") or "").strip()
        if name:
            ingredients.append(f"{amount} {name}".strip())
    return {
        "name": meal.get("strMeal"),
        "category": meal.get("strCategory"),
        "area": meal.get("strArea"),
        "instructions": meal.get("strInstructions"),
        "ingredients": ingredients,
        "image": meal.get("strMealThumb"),
        "youtube": meal.get("strYoutube"),
        "source": meal.get("strSource"),
    }


class RecipeMealDBSkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "themealdb":
            raise ValueError(f"Unknown mechanism: {method}")
        query = (parameters.get("query") or "").strip()
        if not query:
            return MechanismResult(success=False, error="no query provided")
        by_ingredient = bool(parameters.get("by_ingredient"))
        endpoint = "/filter.php" if by_ingredient else "/search.php"
        param_key = "i" if by_ingredient else "s"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{BASE}{endpoint}", params={param_key: query})
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if resp.status_code != 200:
            return MechanismResult(success=False, error=f"http {resp.status_code}")
        try:
            payload = resp.json() or {}
        except ValueError:
            return MechanismResult(success=False, error="malformed response")
        meals = payload.get("meals") or []
        if not meals:
            return MechanismResult(success=False, error=f"no recipes found for '{query}'")
        # If filter.php (by ingredient) we only get stubs — fetch first 3 full records.
        if by_ingredient:
            stubs = meals[:3]
            full = []
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    for stub in stubs:
                        r = await client.get(f"{BASE}/lookup.php", params={"i": stub.get("idMeal")})
                        if r.status_code == 200:
                            data = r.json() or {}
                            for m in (data.get("meals") or [])[:1]:
                                full.append(_shape_meal(m))
            except httpx.HTTPError:
                pass
            recipes = full or [{"name": s.get("strMeal"), "image": s.get("strMealThumb")} for s in stubs]
        else:
            recipes = [_shape_meal(m) for m in meals[:3]]
        return MechanismResult(
            success=True,
            data={"query": query, "recipes": recipes},
            source_url="https://www.themealdb.com",
            source_title="TheMealDB",
        )
