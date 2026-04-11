"""Cached runtime capability registry for the v2 prototype."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from v2.bmo_nlu.registry.builder import build_router_index
from v2.bmo_nlu.registry.loader import load_function_registry


@dataclass(slots=True)
class CapabilityRuntime:
    capabilities: dict[str, dict]
    router_index: list[dict]


@lru_cache(maxsize=1)
def get_runtime() -> CapabilityRuntime:
    """Return the cached v2 registry/runtime."""
    items = load_function_registry()
    capabilities = {item["capability"]: item for item in items if item.get("enabled", True)}
    return CapabilityRuntime(
        capabilities=capabilities,
        router_index=build_router_index(items),
    )
