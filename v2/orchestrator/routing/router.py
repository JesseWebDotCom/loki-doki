"""Registry-backed router for the v2 prototype."""
from __future__ import annotations

import asyncio
import math

from v2.orchestrator.core.types import RequestChunk, RouteMatch
from v2.orchestrator.registry.runtime import CapabilityRuntime, get_runtime


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    numerator = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return numerator / (left_norm * right_norm)


def route_chunk(chunk: RequestChunk, runtime: CapabilityRuntime | None = None) -> RouteMatch:
    """Map a chunk to a prototype capability using the cached registry."""
    active_runtime = runtime or get_runtime()
    query = " ".join(chunk.text.lower().split())
    query_vector = active_runtime.embed_query(query)
    best_capability = "direct_chat"
    best_score = 0.0
    best_text = ""

    for item in active_runtime.router_index:
        texts = item.get("texts") or []
        vectors = item.get("vectors") or []
        for text, vector in zip(texts, vectors, strict=True):
            score = _cosine_similarity(query_vector, vector)
            if score > best_score:
                best_score = score
                best_capability = item["capability"]
                best_text = text

    confidence = max(best_score, 0.55 if best_capability == "direct_chat" else best_score)
    return RouteMatch(
        chunk_index=chunk.index,
        capability=best_capability,
        confidence=round(confidence, 3),
        matched_text=best_text,
    )


async def route_chunk_async(
    chunk: RequestChunk,
    runtime: CapabilityRuntime | None = None,
) -> RouteMatch:
    """Offload routing work so embedding calls do not block the event loop."""
    return await asyncio.to_thread(route_chunk, chunk, runtime)
