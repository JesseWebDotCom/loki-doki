"""Per-skill configuration backed by the capability registry.

Skills call ``get_skill_config(capability, key, default)`` instead of
using module-level constants. The value comes from the registry entry's
``config`` dict, with the provided default as fallback.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def _load_config_map() -> dict[str, dict[str, Any]]:
    from v2.orchestrator.registry.loader import load_function_registry

    items = load_function_registry()
    return {
        item["capability"]: item.get("config") or {}
        for item in items
    }


def get_skill_config(capability: str, key: str, default: Any = None) -> Any:
    """Read a per-skill config value from the registry."""
    config_map = _load_config_map()
    return config_map.get(capability, {}).get(key, default)
