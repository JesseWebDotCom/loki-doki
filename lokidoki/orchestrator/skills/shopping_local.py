"""Offline-first product recommendation backend.

LokiDoki never shipped a product-search skill, and there
is no permissive free product-catalog API we can build on. Until a real
provider (Amazon PA-API, Best Buy, etc.) is wired in, this module
delivers deterministic curated picks from a small in-process catalog
and writes user picks to a JSON store the same way the other
``device.*`` skills do.

Mechanism chain (mirrors ``BaseSkill.execute_mechanism`` pattern):

  1. ``local_catalog`` — instant in-memory category lookup with optional
     budget filter.
  2. ``local_store`` — overlay any user-added picks from
     ``lokidoki/orchestrator/data/shopping.json``.
  3. graceful failure — return a polite "no curated picks" sentence
     and an ``AdapterResult.success=False`` so the combiner / LLM
     fallback can take over without raising.

The catalog intentionally lists three picks per category (good /
better / best) so the response shape stays predictable for tests and
the trace UI.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills._store import load_store, save_store


# ---------------------------------------------------------------------------
# Curated product knowledge base
#
# Each row is ``(name, price_usd, blurb)``. Prices are MSRPs as of 2024-2025
# and are static — they exist only so the budget filter can rank picks.
# ---------------------------------------------------------------------------

_CATALOG: dict[str, list[tuple[str, int, str]]] = {
    "laptop": [
        ("Acer Aspire 5", 549, "solid budget pick for everyday work"),
        ("ASUS ROG Strix G15", 999, "best gaming laptop under $1000"),
        ("Apple MacBook Air M3", 1099, "best all-round ultraportable"),
    ],
    "gaming laptop": [
        ("Acer Nitro V 15", 749, "entry-level 1080p gaming"),
        ("ASUS ROG Strix G15", 999, "best gaming laptop under $1000"),
        ("Lenovo Legion Pro 5", 1399, "high-refresh 1440p gaming"),
    ],
    "headset": [
        ("HyperX Cloud Stinger 2", 49, "best cheap wired headset"),
        ("SteelSeries Arctis Nova 5", 129, "wireless mid-range"),
        ("Sony WH-1000XM5", 399, "premium ANC over-ear"),
    ],
    "headphones": [
        ("Sony WH-CH520", 49, "best budget wireless"),
        ("Sony WH-1000XM5", 399, "best premium noise-canceling"),
        ("Apple AirPods Max", 549, "best for the Apple ecosystem"),
    ],
    "keyboard": [
        ("Keychron C3 Pro", 49, "best budget mechanical"),
        ("Keychron K2 Pro", 109, "best wireless mechanical"),
        ("Logitech MX Keys S", 119, "best low-profile productivity"),
    ],
    "mechanical keyboard": [
        ("Keychron C3 Pro", 49, "best budget mechanical"),
        ("Keychron K2 Pro", 109, "best wireless mechanical"),
        ("Wooting 60HE", 199, "premium analog switches"),
    ],
    "mouse": [
        ("Logitech G203 Lightsync", 39, "best budget gaming mouse"),
        ("Logitech MX Master 3S", 99, "best productivity mouse"),
        ("Razer DeathAdder V3 Pro", 149, "best wireless gaming mouse"),
    ],
    "monitor": [
        ("LG 27GP750-B", 299, "best 1080p 240Hz IPS"),
        ("Dell S2722QC 27", 379, "best 4K USB-C monitor"),
        ("LG 27GR95QE", 999, "premium QD-OLED gaming"),
    ],
    "running shoe": [
        ("Brooks Ghost 16", 140, "best daily trainer"),
        ("Hoka Clifton 9", 145, "best cushioning"),
        ("Nike Pegasus 41", 140, "best all-rounder"),
    ],
    "puppy": [
        ("Wellness Complete Puppy Food", 25, "highly rated puppy kibble"),
        ("Frisco Crate (medium)", 60, "starter crate, mid-size"),
        ("KONG Puppy Toy", 11, "vet-recommended teething toy"),
    ],
    "phone": [
        ("Google Pixel 8a", 499, "best mid-range Android"),
        ("Apple iPhone 15", 699, "best mainstream iPhone"),
        ("Samsung Galaxy S24 Ultra", 1299, "best premium flagship"),
    ],
    "tablet": [
        ("Amazon Fire HD 10", 149, "best budget tablet"),
        ("Apple iPad (10th gen)", 349, "best all-round iPad"),
        ("Apple iPad Pro M4 11", 999, "best premium tablet"),
    ],
    "tv": [
        ("TCL Q6 55-inch", 399, "best budget 4K TV"),
        ("Hisense U7N 65-inch", 899, "best mid-range mini-LED"),
        ("LG C4 65-inch OLED", 1799, "best premium OLED"),
    ],
    "camera": [
        ("Sony ZV-1F", 499, "best vlogging compact"),
        ("Fujifilm X-T5", 1699, "best APS-C all-rounder"),
        ("Sony A7 IV", 2499, "best full-frame hybrid"),
    ],
    "smartwatch": [
        ("Amazfit Bip 5", 89, "best budget smartwatch"),
        ("Apple Watch SE", 249, "best Apple smartwatch"),
        ("Garmin Fenix 7", 699, "best for athletes"),
    ],
}

# Aliases let common phrasings ("gaming pc", "wireless earbuds") collapse
# onto a real catalog row. Order matters — first match wins.
_ALIASES: tuple[tuple[str, str], ...] = (
    ("gaming laptop", "gaming laptop"),
    ("laptop for gaming", "gaming laptop"),
    ("gaming pc", "gaming laptop"),
    ("mechanical keyboard", "mechanical keyboard"),
    ("wireless mouse", "mouse"),
    ("gaming mouse", "mouse"),
    ("noise canceling headphones", "headphones"),
    ("wireless headphones", "headphones"),
    ("wireless earbuds", "headphones"),
    ("earbuds", "headphones"),
    ("gaming headset", "headset"),
    ("gaming monitor", "monitor"),
    ("4k tv", "tv"),
    ("oled tv", "tv"),
    ("running shoes", "running shoe"),
    ("runners", "running shoe"),
    ("new puppy", "puppy"),
    ("puppy supplies", "puppy"),
    ("smart watch", "smartwatch"),
    ("fitness watch", "smartwatch"),
    ("apple watch", "smartwatch"),
)


_BUDGET_RE = re.compile(r"\b(?:under|below|less than|<|max(?:imum)?)\s*\$?\s*(\d{2,5})\b", re.IGNORECASE)
_PRICE_RE = re.compile(r"\$\s*(\d{2,5})", re.IGNORECASE)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").lower().strip(" ?.!,"))


def _resolve_category(query: str) -> str | None:
    text = _normalize(query)
    if not text:
        return None
    for needle, target in _ALIASES:
        if needle in text:
            return target
    for category in _CATALOG:
        if category in text:
            return category
    # Fall back to single-word match against catalog keys.
    for token in text.split():
        if token in _CATALOG:
            return token
    return None


def _resolve_budget(query: str) -> int | None:
    text = str(query or "")
    match = _BUDGET_RE.search(text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    match = _PRICE_RE.search(text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


def _format(category: str, picks: list[tuple[str, int, str]]) -> str:
    if not picks:
        return f"I don't have curated picks for {category} right now."
    body = "; ".join(f"{name} (${price}) — {blurb}" for name, price, blurb in picks)
    return f"Top picks for {category}: {body}."


def _store_extras(category: str) -> list[tuple[str, int, str]]:
    """Return any user-added picks from the local shopping store."""
    store = load_store("shopping", {"picks": {}})
    raw = store.get("picks", {}).get(category, [])
    extras: list[tuple[str, int, str]] = []
    for entry in raw:
        try:
            extras.append((str(entry["name"]), int(entry["price"]), str(entry.get("blurb", ""))))
        except (KeyError, TypeError, ValueError):
            continue
    return extras


def add_pick(category: str, name: str, price: int, blurb: str = "") -> None:
    """Test/utility helper — add a curated pick to the local store."""
    store = load_store("shopping", {"picks": {}})
    bucket = store.setdefault("picks", {}).setdefault(category, [])
    bucket.append({"name": name, "price": int(price), "blurb": blurb})
    save_store("shopping", store)


def _filter_and_slice_picks(
    picks: list,
    raw_query: str,
    raw_budget: Any,
) -> tuple[list, Any]:
    """Apply budget filter, slice to top 3, and return (picks, normalized_budget)."""
    budget = _resolve_budget(raw_query) or raw_budget
    if isinstance(budget, str):
        try:
            budget = int(re.sub(r"[^0-9]", "", budget) or "0") or None
        except ValueError:
            budget = None
    if isinstance(budget, (int, float)) and budget > 0:
        filtered = [pick for pick in picks if pick[1] <= int(budget)]
        if filtered:
            picks = filtered
    return picks[:3], budget


def find_products(payload: dict[str, Any]) -> dict[str, Any]:
    """Synchronous, offline-first product recommendation handler."""
    params = payload.get("params") or {}
    raw_query = str(params.get("category") or payload.get("chunk_text") or "")
    category = _resolve_category(raw_query)
    if category is None:
        return AdapterResult(
            output_text=(
                "I don't have curated picks for that category yet. "
                "Try asking about laptops, headphones, keyboards, monitors, "
                "phones, tablets, TVs, cameras, or running shoes."
            ),
            success=False,
            mechanism_used="local_catalog",
            error="unknown category",
        ).to_payload()

    # User-curated picks rank ahead of the built-in catalog so a "best
    # laptop" lookup surfaces locally added recommendations first.
    all_picks = _store_extras(category) + list(_CATALOG[category])
    picks, budget = _filter_and_slice_picks(all_picks, raw_query, params.get("budget"))
    return AdapterResult(
        output_text=_format(category, picks),
        success=True,
        mechanism_used="local_catalog",
        data={
            "category": category,
            "budget_usd": int(budget) if isinstance(budget, (int, float)) else None,
            "picks": [
                {"name": name, "price_usd": price, "blurb": blurb}
                for name, price, blurb in picks
            ],
        },
    ).to_payload()


__all__ = ["add_pick", "find_products"]
