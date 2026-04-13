"""Loads the pipeline capability registry."""
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
    registry_path = Path(__file__).resolve().parents[1] / "data" / "function_registry.json"
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


def build_handler_map() -> dict[str, tuple[str, str]]:
    """Build the lazy-load handler map from registry implementations.

    Reads ``module_path`` and ``entry_point`` from each implementation
    in function_registry.json and returns a dict mapping handler_name
    to ``(module_path, entry_point)`` for ``importlib.import_module``
    resolution at call time.

    Implementations without ``module_path`` (built-in handlers like
    greetings, time, date) are skipped — those are resolved by the
    executor's ``_BUILTIN_HANDLERS`` dict.
    """
    items = load_function_registry()
    handler_map: dict[str, tuple[str, str]] = {}
    for item in items:
        for impl in item.get("implementations") or []:
            handler_name = impl.get("handler_name", "")
            module_path = impl.get("module_path", "")
            entry_point = impl.get("entry_point", "")
            if handler_name and module_path and entry_point:
                handler_map.setdefault(handler_name, (module_path, entry_point))
    return handler_map
