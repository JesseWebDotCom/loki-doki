"""Loads the v2 prototype capability registry."""
from __future__ import annotations

import json
from pathlib import Path


def load_function_registry() -> list[dict]:
    """Load the static prototype capability registry.

    Entries with an ``aliases`` list are expanded so each alias appears
    as a separate virtual entry in the returned list. This keeps the
    router and runtime code alias-unaware — every capability name they
    see is a real entry with its own examples and implementations.
    """
    registry_path = Path(__file__).resolve().parents[2] / "data" / "function_registry.json"
    raw: list[dict] = json.loads(registry_path.read_text())
    expanded: list[dict] = []
    for item in raw:
        expanded.append(item)
        alias_examples_map = item.get("alias_examples") or {}
        for alias in item.get("aliases") or []:
            alias_entry = {
                **item,
                "capability": alias,
                "aliases": [],
                "alias_examples": {},
                "examples": alias_examples_map.get(alias, item.get("examples", [])[:3]),
            }
            expanded.append(alias_entry)
    return expanded
