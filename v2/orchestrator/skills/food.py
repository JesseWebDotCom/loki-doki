"""Food skills: recipes, substitutions, nutrition, and order drafts."""
from __future__ import annotations

from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult
from v2.orchestrator.skills._store import load_store, next_id, save_store

_SUBS = {
    "buttermilk": "milk plus a little lemon juice or vinegar",
    "egg": "flax egg or applesauce in baking",
    "butter": "olive oil or coconut oil",
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
    return AdapterResult(
        output_text=f"{product.get('product_name') or food}: {calories or '?'} kcal and {protein or '?'} g protein per 100g.",
        success=True,
        mechanism_used="open_food_facts",
        data=product,
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
