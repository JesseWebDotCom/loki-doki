"""Pronoun resolver for the v2 prototype.

Walks the chunk's references ("it", "that", "they", "him", "her") and
binds them to the most recently mentioned entity in conversation memory.
The resolver does not guess: ambiguous or missing referents are flagged
so the combiner / Gemma fallback can ask the user.
"""
from __future__ import annotations

from v2.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter, RecentEntity
from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch
from v2.orchestrator.linguistics import DETERMINERS

# Subset of the closed pronoun class that the resolver actually binds to a
# concrete entity. We do not try to resolve "I" / "you" / "we" — those refer
# to the speaker / listener and are handled at the synthesis layer.
PRONOUN_TARGETS = frozenset({"it", "this", "that", "they", "them", "him", "her", "he", "she"})

# Capabilities where the pronoun ("it" in "what time is it") is a dummy
# subject, not a real referent. The pronoun resolver must NOT run for these.
# Same goes for definite-determiner phrases inside a knowledge query — "the
# runtime of the godfather" is a noun-phrase argument to the query, not a
# referent that needs context binding.
DIRECT_UTILITY_CAPABILITIES = {
    "get_current_time",
    "get_current_date",
    "greeting_response",
    "acknowledgment_response",
    "spell_word",
    "calculate_math",
    "convert_units",
    "get_weather",
    "get_movie_showtimes",
    "lookup_person_birthday",
    "knowledge_query",
    # direct_chat is the conversational catch-all. Its handler echoes the
    # chunk text so the chunk text *is* the answer — pronouns inside it
    # ("fix it", "explain it") are not referents that need binding.
    "direct_chat",
}

# Pronoun → preferred entity types (best-effort guess from English usage).
PRONOUN_PREFERRED_TYPES: dict[str, tuple[str, ...]] = {
    "him": ("person",),
    "her": ("person",),
    "he": ("person",),
    "she": ("person",),
    "they": ("person",),
    "them": ("person",),
    "it": ("movie", "film", "media", "song", "device", "tv_show"),
    "this": ("movie", "film", "media"),
    "that": ("movie", "film", "media"),
}


def resolve_pronouns(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    memory: ConversationMemoryAdapter,
) -> ResolutionResult | None:
    """Return a referent binding when the chunk contains pronouns or definite refs."""
    if route.capability in DIRECT_UTILITY_CAPABILITIES:
        return None
    references = [ref.lower() for ref in extraction.references]
    pronouns = [ref for ref in references if ref in PRONOUN_TARGETS]
    # Definite references are noun phrases that the extractor flagged because
    # they start with a determiner ("the movie", "that film", "this song").
    # No literal phrase list — the structure of the parse is the trigger.
    definites = [
        ref for ref in references
        if ref not in PRONOUN_TARGETS and (ref.split() and ref.split()[0] in DETERMINERS)
    ]
    if not pronouns and not definites:
        return None

    target_types: tuple[str, ...]
    if pronouns:
        target_types = PRONOUN_PREFERRED_TYPES.get(pronouns[0], ())
    else:
        target_types = ("movie", "film", "media")

    candidates = _candidates_for(memory, target_types)
    if not candidates:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="",
            source="unresolved_referent",
            confidence=route.confidence,
            unresolved=[f"referent:{(pronouns or definites)[0]}"],
            notes=["no recent entity to bind referent"],
        )

    if len(candidates) > 1:
        names = [entity.name for entity in candidates]
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target=candidates[0].name,
            source="ambiguous_referent",
            confidence=route.confidence,
            candidate_values=names,
            unresolved=[f"referent_ambiguous:{(pronouns or definites)[0]}"],
            params={
                "referent": (pronouns or definites)[0],
                "candidates": names,
            },
            notes=[f"{len(candidates)} candidates for {(pronouns or definites)[0]}"],
        )

    primary = candidates[0]
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=primary.name,
        source="referent",
        confidence=route.confidence,
        context_value=primary.name,
        params={
            "referent": (pronouns or definites)[0],
            "entity_type": primary.entity_type,
            "entity_name": primary.name,
        },
    )


def _candidates_for(
    memory: ConversationMemoryAdapter,
    preferred_types: tuple[str, ...],
) -> list[RecentEntity]:
    if preferred_types:
        for entity_type in preferred_types:
            results = memory.recent_entities(entity_type=entity_type)
            if results:
                return results
    return memory.recent_entities()
