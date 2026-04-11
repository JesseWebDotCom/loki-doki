"""Cached runtime capability registry for the v2 prototype."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from v2.bmo_nlu.core.types import ImplementationSelection
from v2.bmo_nlu.registry.builder import build_router_index
from v2.bmo_nlu.registry.loader import load_function_registry
from v2.bmo_nlu.routing.embeddings import EmbeddingBackend, get_embedding_backend


@dataclass(slots=True)
class CapabilityRuntime:
    capabilities: dict[str, dict]
    router_index: list[dict]
    embedding_backend: EmbeddingBackend

    def embed_query(self, text: str) -> list[float]:
        """Embed one normalized query using the startup-selected backend."""
        vectors = self.embedding_backend.embed([text])
        if not vectors:
            return [0.0] * self.embedding_backend.dimensions
        return vectors[0]

    def select_handler(self, chunk_index: int, capability: str) -> ImplementationSelection:
        """Return the highest-priority enabled implementation for a capability."""
        capability_data = self.capabilities.get(capability) or {}
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
        return ImplementationSelection(
            chunk_index=chunk_index,
            capability=capability,
            handler_name=str(selected.get("handler_name") or ""),
            implementation_id=str(selected.get("id") or ""),
            priority=int(selected.get("priority", 999)),
            candidate_count=len(ordered),
        )


@lru_cache(maxsize=1)
def get_runtime() -> CapabilityRuntime:
    """Return the cached v2 registry/runtime."""
    items = load_function_registry()
    backend = get_embedding_backend()
    capabilities = {item["capability"]: item for item in items if item.get("enabled", True)}
    return CapabilityRuntime(
        capabilities=capabilities,
        router_index=build_router_index(items, embed_texts=backend.embed),
        embedding_backend=backend,
    )
