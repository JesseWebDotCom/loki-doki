"""Cached runtime capability registry for the pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

from lokidoki.orchestrator.core.types import ImplementationSelection
from lokidoki.orchestrator.registry.builder import build_router_index
from lokidoki.orchestrator.registry.loader import load_function_registry
from lokidoki.orchestrator.routing.embeddings import EmbeddingBackend, get_embedding_backend


@dataclass(slots=True)
class CapabilityRuntime:
    capabilities: dict[str, dict]
    router_index: list[dict]
    embedding_backend: EmbeddingBackend
    alias_map: dict[str, str] = field(default_factory=dict)

    def embed_query(self, text: str) -> list[float]:
        """Embed one normalized query using the startup-selected backend."""
        vectors = self.embedding_backend.embed([text])
        if not vectors:
            return [0.0] * self.embedding_backend.dimensions
        return vectors[0]

    def resolve_capability(self, capability: str) -> str:
        """Resolve an alias to its canonical capability name."""
        return self.alias_map.get(capability, capability)

    def select_handler(self, chunk_index: int, capability: str) -> ImplementationSelection:
        """Return the highest-priority enabled implementation for a capability."""
        resolved = self.resolve_capability(capability)
        capability_data = self.capabilities.get(resolved) or self.capabilities.get(capability) or {}
        implementations = capability_data.get("implementations") or []
        enabled = [item for item in implementations if item.get("enabled", True)]
        if not enabled:
            return ImplementationSelection(
                chunk_index=chunk_index,
                capability=capability,
                handler_name="fallback.direct_chat",
                implementation_id=f"{capability}.default",
                priority=999,
                candidate_count=0,
            )
        ordered = sorted(enabled, key=lambda item: int(item.get("priority", 999)))
        selected = ordered[0]
        budget_ms = capability_data.get("max_chunk_budget_ms")
        return ImplementationSelection(
            chunk_index=chunk_index,
            capability=capability,
            handler_name=str(selected.get("handler_name") or ""),
            implementation_id=str(selected.get("id") or ""),
            priority=int(selected.get("priority", 999)),
            candidate_count=len(ordered),
            skill_id=str(selected.get("skill_id") or ""),
        )


@lru_cache(maxsize=1)
def get_runtime() -> CapabilityRuntime:
    """Return the cached registry/runtime."""
    items = load_function_registry()
    backend = get_embedding_backend()
    capabilities = {item["capability"]: item for item in items if item.get("enabled", True)}
    # Build alias -> canonical mapping from the expanded loader output.
    # The loader already expands aliases into virtual entries, so each
    # alias shares implementations with its canonical entry.
    alias_map: dict[str, str] = {}
    for item in items:
        for alias in item.get("aliases") or []:
            alias_map[alias] = item["capability"]
    return CapabilityRuntime(
        capabilities=capabilities,
        router_index=build_router_index(items, embed_texts=backend.embed),
        embedding_backend=backend,
        alias_map=alias_map,
    )
