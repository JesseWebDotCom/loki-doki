"""Registry-backed router for the v2 prototype."""
from __future__ import annotations

import asyncio
import math

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.core.types import RequestChunk, RouteMatch
from v2.orchestrator.registry.runtime import CapabilityRuntime, get_runtime

# Hard floor on cosine similarity. When the best registry match scores
# below this, the router refuses to commit to that capability and falls
# back to ``direct_chat`` (which the combiner / LLM fallback then turns
# into a generic clarification response). Without this floor MiniLM picks
# its best-of-noise match for every vague utterance — "fix this" routes
# to ``acknowledgment_response`` because "got it" is the closest example.
#
# Aligned with ``CONFIG.route_confidence_threshold`` (0.55). The two
# values used to drift apart (floor 0.45, threshold 0.55), creating a
# 0.45–0.55 "borderline" band where the router would still commit to a
# specific skill, run the resolver + executor, and then hand the bogus
# skill output to the LLM as ground truth via the ``combine`` prompt.
# Concrete failure: "Maybe I'll take my sister to the movies" scored
# 0.495 against ``when is my sister's birthday``, committed to
# ``lookup_person_birthday``, resolved ``sister`` → seed person Leia,
# and the LLM dutifully repeated "Leia's birthday is June 12." Raising
# the floor to the threshold collapses that band — borderline matches
# become direct_chat, which LLM answers from the user's actual words.
ROUTE_FLOOR = 0.55


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
        if item["capability"] == "direct_chat":
            # direct_chat is the floor-based fallback, never the
            # best-cosine winner — its examples are intentionally vague
            # and would otherwise dominate the index.
            continue
        texts = item.get("texts") or []
        vectors = item.get("vectors") or []
        for text, vector in zip(texts, vectors, strict=True):
            score = _cosine_similarity(query_vector, vector)
            if score > best_score:
                best_score = score
                best_capability = item["capability"]
                best_text = text

    if best_score < ROUTE_FLOOR:
        # Best match was noise — defer to the conversational fallback so
        # the combiner / LLM layer can ask for clarification instead of
        # confidently running the wrong skill.
        best_capability = "direct_chat"
        best_text = ""

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
