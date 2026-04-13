"""Registry-backed router for the pipeline."""
from __future__ import annotations

import asyncio
import math

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.core.types import RequestChunk, RouteMatch
from lokidoki.orchestrator.registry.runtime import CapabilityRuntime, get_runtime

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
RETRIEVAL_FALLBACK_MARGIN = 0.08
RETRIEVAL_FALLBACK_CAPABILITIES = frozenset(
    {
        "knowledge_query",
        "query",
        "lookup_definition",
        "define_word",
        "search_web",
    }
)


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

    best_capability, best_score, best_text = _best_index_match(
        query_vector, active_runtime.router_index, best_capability, best_score, best_text
    )

    if best_score < ROUTE_FLOOR:
        if _should_promote_retrieval_fallback(best_capability, best_score, query):
            return RouteMatch(
                chunk_index=chunk.index,
                capability=best_capability,
                confidence=round(ROUTE_FLOOR + 0.01, 3),
                matched_text=best_text,
            )
        # Best match was noise — defer to the conversational fallback so
        # the combiner / LLM layer can ask for clarification instead of
        # confidently running the wrong skill.
        best_capability = "direct_chat"
        best_text = ""

    # WH-question promotion: factual questions ("what is X", "who is X")
    # that fell to direct_chat should be promoted to knowledge_query so
    # the pipeline searches for the answer instead of relying solely on
    # the LLM's (potentially hallucinated) knowledge.
    if best_capability == "direct_chat" and _is_factual_wh_question(query):
        best_capability = "knowledge_query"

    confidence = max(best_score, 0.55 if best_capability == "direct_chat" else best_score)
    return RouteMatch(
        chunk_index=chunk.index,
        capability=best_capability,
        confidence=round(confidence, 3),
        matched_text=best_text,
    )


def _best_index_match(
    query_vector: list[float],
    router_index: list[dict],
    best_capability: str,
    best_score: float,
    best_text: str,
) -> tuple[str, float, str]:
    """Scan the router index and return (capability, score, text) for the best match."""
    for item in router_index:
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
    return best_capability, best_score, best_text


_FACTUAL_WH_PREFIXES = (
    "what is ", "what's ", "what are ", "what was ", "what were ",
    "what year ", "what time ", "what day ", "what date ",
    "who is ", "who are ", "who was ",
    "where is ", "where are ", "where was ", "where did ",
    "when is ", "when was ", "when did ",
    "how do i ", "how does ", "how do you ", "how many ", "how much ",
    "is there ", "is it ",
    "does ", "did ", "can you ",
)


def _is_factual_wh_question(query: str) -> bool:
    """True if the query looks like a factual question.

    Matches both standalone ("what is Claude Cowork") and pronoun
    follow-ups ("is it free") — the caller is responsible for resolving
    pronouns before the query reaches the search handler.
    """
    q = query.strip().lower()
    if not q.startswith(_FACTUAL_WH_PREFIXES):
        return False
    chitchat = {"what's up", "what is up", "how are you", "how do you do",
                "what's new", "what is new", "what's happening",
                "what's going on", "how is it going", "how's it going"}
    return q.rstrip("?. ") not in chitchat


def _should_promote_retrieval_fallback(capability: str, score: float, query_text: str = "") -> bool:
    """Promote near-floor factual lookups into retrieval instead of LLM chat.

    Retrieval-backed capabilities can safely validate the guess by
    trying the underlying source. That makes a near-miss much cheaper
    than sending a named-thing question straight to ``direct_chat`` and
    asking the LLM to answer from memory.
    """
    if capability not in RETRIEVAL_FALLBACK_CAPABILITIES:
        return False

    # Base margin: 0.12 (score >= 0.43)
    margin = 0.12
    
    # Nudge for definitional questions (who/what/where/when/how/is/does)
    # If it's a question, we are even more willing to try a search.
    wh_nudge = (
        "who ", "what ", "where ", "when ", "how ", "is ", "was ", "does ", "did ", "can "
    )
    if query_text.lower().startswith(wh_nudge):
        margin = 0.15 # score >= 0.40

    return score >= (ROUTE_FLOOR - margin)


async def route_chunk_async(
    chunk: RequestChunk,
    runtime: CapabilityRuntime | None = None,
) -> RouteMatch:
    """Offload routing work so embedding calls do not block the event loop."""
    return await asyncio.to_thread(route_chunk, chunk, runtime)
