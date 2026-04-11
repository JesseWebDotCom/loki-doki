"""Registry-backed router for the v2 prototype."""
from __future__ import annotations

import asyncio
from difflib import SequenceMatcher

from v2.bmo_nlu.core.types import RequestChunk, RouteMatch
from v2.bmo_nlu.registry.runtime import CapabilityRuntime, get_runtime


def _score_text(query: str, candidate: str) -> float:
    query_tokens = set(query.split())
    candidate_tokens = set(candidate.split())
    overlap = len(query_tokens & candidate_tokens)
    token_score = overlap / max(len(query_tokens), 1)
    ratio_score = SequenceMatcher(None, query, candidate).ratio()
    return max(token_score, ratio_score)


def route_chunk(chunk: RequestChunk, runtime: CapabilityRuntime | None = None) -> RouteMatch:
    """Map a chunk to a prototype capability using the cached registry."""
    active_runtime = runtime or get_runtime()
    query = " ".join(chunk.text.lower().split())
    best_capability = "direct_chat"
    best_score = 0.0
    best_text = ""

    for item in active_runtime.router_index:
        for text in item["texts"]:
            score = _score_text(query, text)
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
    """Async wrapper for future parallel routing."""
    await asyncio.sleep(0)
    return route_chunk(chunk, runtime)
