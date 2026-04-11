"""Builds a routing index from the v2 capability registry."""
from __future__ import annotations


def build_router_index(items: list[dict]) -> list[dict]:
    """Normalize enabled capabilities into a routing index."""
    index: list[dict] = []
    for item in items:
        if not item.get("enabled", True):
            continue
        texts = [item.get("description", ""), *(item.get("examples") or [])]
        normalized = [" ".join(str(text).lower().split()) for text in texts if str(text).strip()]
        index.append(
            {
                "capability": item["capability"],
                "texts": normalized,
            }
        )
    return index
