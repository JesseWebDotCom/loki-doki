"""Pronoun resolver for the pipeline.

Walks the chunk's references ("it", "that", "they", "him", "her") and
binds them to the most recently mentioned entity in conversation memory.
The resolver does not guess: ambiguous or missing referents are flagged
so the combiner / LLM fallback can ask the user.
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter, RecentEntity
from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch
from lokidoki.orchestrator.linguistics import DETERMINERS

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
    # Stub skills from the ChatGPT routing-table buildout. These all read
    # their parameters out of the chunk text directly (or from explicit
    # extraction params) rather than from a context-bound referent, so the
    # pronoun resolver should not flip their success flag for definite NPs
    # ("the garage", "this article", "this code") inside the utterance.
    "get_indoor_temperature",
    "detect_presence",
    "get_device_state",
    "get_time_in_location",
    "generate_email",
    "code_assistance",
    "summarize_text",
    "create_plan",
    "weigh_options",
    "find_products",
    "emotional_support",
    # v1-port skills with definite NPs in their canonical phrasing
    # ("the headlines", "the tv show X", "the recipe for Y").
    "lookup_definition",
    "get_news_headlines",
    "find_recipe",
    "tell_joke",
    "lookup_tv_show",
    # Movie skills carry the title in the chunk text ("the movie inception").
    # Pronoun-based queries ("who's in it") route to recall_recent_media.
    "lookup_movie",
    "search_movies",
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

    trigger = (pronouns or definites)[0]
    target_types: tuple[str, ...] = (
        PRONOUN_PREFERRED_TYPES.get(pronouns[0], ()) if pronouns else ("movie", "film", "media")
    )
    candidates = _candidates_for(memory, target_types)
    return _build_pronoun_resolution(chunk, route, candidates, trigger)


def _build_pronoun_resolution(
    chunk: RequestChunk,
    route: RouteMatch,
    candidates: list[RecentEntity],
    trigger: str,
) -> ResolutionResult:
    """Build the appropriate ResolutionResult based on candidate count."""
    if not candidates:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="",
            source="unresolved_referent",
            confidence=route.confidence,
            unresolved=[f"referent:{trigger}"],
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
            unresolved=[f"referent_ambiguous:{trigger}"],
            params={"referent": trigger, "candidates": names},
            notes=[f"{len(candidates)} candidates for {trigger}"],
        )

    primary = candidates[0]
    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=primary.name,
        source="referent",
        confidence=route.confidence,
        context_value=primary.name,
        params={"referent": trigger, "entity_type": primary.entity_type, "entity_name": primary.name},
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
