"""Builds a routing index from the capability registry."""
from __future__ import annotations

from collections.abc import Callable

from lokidoki.orchestrator.routing.embeddings import get_embedding_backend


def build_router_index(
    items: list[dict],
    *,
    embed_texts: Callable[[list[str]], list[list[float]]] | None = None,
) -> list[dict]:
    """Normalize enabled capabilities into a routing index."""
    backend = get_embedding_backend()
    embed = embed_texts or backend.embed
    index: list[dict] = []
    for item in items:
        if not item.get("enabled", True):
            continue
        texts = [item.get("description", ""), *(item.get("examples") or [])]
        normalized = [" ".join(str(text).lower().split()) for text in texts if str(text).strip()]
        vectors = embed(normalized)
        vector_dim = len(vectors[0]) if vectors else backend.dimensions
        index.append(
            {
                "capability": item["capability"],
                "texts": normalized,
                "vectors": vectors,
                "vector_dim": vector_dim,
            }
        )
    return index
