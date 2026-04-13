"""Food skills: recipes, substitutions, nutrition, and order drafts."""
from __future__ import annotations

from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult
from v2.orchestrator.skills._store import load_store, next_id, save_store

_SUBS = {
    # Dairy
    "buttermilk": "milk plus a tablespoon of lemon juice or vinegar per cup",
    "butter": "olive oil, coconut oil, or margarine (equal amount)",
    "heavy cream": "coconut cream or full-fat coconut milk",
    "sour cream": "plain Greek yogurt (equal amount)",
    "cream cheese": "Neufchâtel cheese or blended silken tofu",
    "milk": "oat milk, almond milk, or soy milk (equal amount)",
    "yogurt": "sour cream, buttermilk, or coconut yogurt",
    "parmesan": "nutritional yeast (vegan) or Pecorino Romano",
    # Eggs & binders
    "egg": "flax egg (1 tbsp ground flax + 3 tbsp water), chia egg, or ¼ cup applesauce per egg",
    "egg whites": "aquafaba (liquid from canned chickpeas), 3 tbsp per egg white",
    # Fats & oils
    "vegetable oil": "melted coconut oil, applesauce (in baking), or avocado oil",
    "shortening": "butter or coconut oil",
    "lard": "butter, coconut oil, or vegetable shortening",
    # Flour & starches
    "all-purpose flour": "whole wheat flour (use ¾ the amount) or gluten-free 1:1 blend",
    "bread flour": "all-purpose flour plus ½ tsp vital wheat gluten per cup",
    "cake flour": "all-purpose flour minus 2 tbsp per cup, plus 2 tbsp cornstarch",
    "cornstarch": "arrowroot powder or tapioca starch (equal amount)",
    "breadcrumbs": "crushed crackers, panko, or rolled oats",
    # Sweeteners
    "white sugar": "honey (¾ cup per cup, reduce liquid by 2 tbsp), maple syrup, or coconut sugar",
    "brown sugar": "white sugar plus 1 tbsp molasses per cup",
    "corn syrup": "honey, maple syrup, or golden syrup",
    "honey": "maple syrup or agave nectar (equal amount)",
    "molasses": "dark corn syrup or honey plus cocoa powder",
    # Acids & vinegars
    "lemon juice": "lime juice, white wine vinegar, or citric acid solution",
    "white wine vinegar": "apple cider vinegar or champagne vinegar",
    "rice vinegar": "apple cider vinegar diluted with a little water",
    # Herbs & spices
    "fresh herbs": "dried herbs (use ⅓ the amount of fresh)",
    "saffron": "turmeric for color (not flavor), or annatto",
    "allspice": "½ tsp cinnamon + ¼ tsp nutmeg + ¼ tsp cloves",
    # Sauces & condiments
    "soy sauce": "coconut aminos or tamari (gluten-free)",
    "tomato paste": "ketchup (use double) or sun-dried tomato purée",
    "worcestershire sauce": "soy sauce plus a dash of lemon juice",
    "fish sauce": "soy sauce plus a squeeze of lime",
    # Alcohol
    "wine": "broth or stock plus a splash of vinegar",
    "beer": "broth or non-alcoholic beer",
    # Misc
    "broth": "water plus bouillon cube, or mushroom soaking liquid",
    "coconut milk": "heavy cream (non-vegan) or cashew cream",
    "mayo": "mashed avocado, Greek yogurt, or hummus",
    "chocolate": "carob powder (3 tbsp per ounce of chocolate)",
}
_ORDER_DEFAULT = {"orders": []}


async def get_nutrition(payload: dict[str, Any]) -> dict[str, Any]:
    food = str((payload.get("params") or {}).get("food") or payload.get("chunk_text") or "").strip()
    async with httpx.AsyncClient(timeout=6.0) as client:
        response = await client.get(
            "https://world.openfoodfacts.org/cgi/search.pl",
            params={"search_terms": food, "search_simple": 1, "action": "process", "json": 1, "page_size": 1},
            headers={"User-Agent": "LokiDoki/0.2"},
        )
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't look up nutrition right now.", success=False, error=f"http {response.status_code}").to_payload()
    products = response.json().get("products") or []
    if not products:
        return AdapterResult(output_text="I couldn't find nutrition data for that food.", success=False, error="no results").to_payload()
    product = products[0]
    nutriments = product.get("nutriments") or {}
    calories = nutriments.get("energy-kcal_100g")
    protein = nutriments.get("proteins_100g")
    product_name = product.get("product_name") or food
    return AdapterResult(
        output_text=f"{product_name}: {calories or '?'} kcal and {protein or '?'} g protein per 100g.",
        success=True,
        mechanism_used="open_food_facts",
        data=product,
        source_url=f"https://world.openfoodfacts.org/product/{product.get('code', '')}",
        source_title=f"Open Food Facts — {product_name}",
    ).to_payload()


def substitute_ingredient(payload: dict[str, Any]) -> dict[str, Any]:
    ingredient = str((payload.get("params") or {}).get("ingredient") or payload.get("chunk_text") or "").lower()
    for key, value in _SUBS.items():
        if key in ingredient:
            return AdapterResult(output_text=f"A good substitute for {key} is {value}.", success=True, mechanism_used="local_substitutions").to_payload()
    return AdapterResult(output_text="I don't have a strong substitution for that ingredient yet.", success=False, error="unknown ingredient").to_payload()


def order_food(payload: dict[str, Any]) -> dict[str, Any]:
    store = load_store("food_orders", _ORDER_DEFAULT)
    text = str(payload.get("chunk_text") or "")
    order = {"id": next_id(store["orders"], "order"), "request": text, "status": "draft"}
    store["orders"].append(order)
    save_store("food_orders", store)
    return AdapterResult(output_text=f"Saved a food order draft: {text}.", success=True, mechanism_used="local_food_order", data=order).to_payload()
