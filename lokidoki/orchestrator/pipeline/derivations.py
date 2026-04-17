"""Deterministic derivation of pipeline flags from parse + route results.

Derives structured fields the pipeline
consumes. Every flag is derived from data the pipeline already computed
(spaCy parse, extraction, routing) — zero additional model calls.

The derivation step runs **after** routing + extraction but **before**
memory_read, so the memory read path can gate on the derived flags.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.core.types import (
    ChunkExtraction,
    ParsedInput,
    RequestChunk,
    RouteMatch,
)
from lokidoki.orchestrator.linguistics import FAMILY_RELATIONS, PRONOUNS


# ---- flag derivation --------------------------------------------------------

# Capabilities where user-preference memory (Tier 4) is likely relevant.
_PREFERENCE_CAPABILITIES: frozenset[str] = frozenset({
    "direct_chat",
    "knowledge_query",
    "query",
    "get_recommendation",
    "lookup_definition",
    "define_word",
    "news_search",
})

# Capabilities that involve people and benefit from the social graph.
_SOCIAL_CAPABILITIES: frozenset[str] = frozenset({
    "send_text_message",
    "lookup_person_birthday",
    "lookup_person_address",
    "lookup_person_facts",
    "lookup_relationship",
    "list_family",
    "call_contact",
    "add_calendar_event",
})

# Lemmas that signal routine / procedural behavior relevance (Tier 7).
_ROUTINE_LEMMAS: frozenset[str] = frozenset({
    "usually", "always", "often", "typically", "normally",
    "routine", "habit", "schedule", "pattern",
    "prefer", "preference",
})

# Lemmas that signal the user is referencing a past conversation.
_EPISODE_LEMMAS: frozenset[str] = frozenset({
    "remember", "recall", "forgot", "forget",
    "mentioned", "discussed", "talked",
    "last time", "earlier", "before",
    "you said", "i told you", "we talked",
})

# Self-referencing pronouns that hint at preference relevance.
_SELF_PRONOUNS: frozenset[str] = frozenset({
    "i", "me", "my", "mine", "myself",
})

# Preference-related lemmas (verbs/adjectives).
_PREFERENCE_LEMMAS: frozenset[str] = frozenset({
    "like", "love", "hate", "prefer", "enjoy", "dislike",
    "favorite", "favourite", "allergic", "intolerant",
    "want", "need",
})

# Third-person and demonstrative pronouns that signal session-context need.
_REFERENT_PRONOUNS: frozenset[str] = frozenset({
    "he", "him", "his", "she", "her", "hers",
    "it", "its", "they", "them", "their",
    "this", "that", "these", "those",
})


def derive_need_flags(
    parsed: ParsedInput,
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
    context: dict[str, Any],
) -> dict[str, bool]:
    """Derive ``need_*`` flags from pipeline state.

    Returns a dict of flag names to booleans. Only flags derived as True
    are included — callers merge these into ``safe_context`` with
    ``dict.setdefault`` so explicit caller overrides are respected.
    """
    flags: dict[str, bool] = {}

    if _should_need_preference(parsed, routes, context):
        flags["need_preference"] = True
    if _should_need_social(parsed, extractions, routes):
        flags["need_social"] = True
    if _should_need_session_context(extractions):
        flags["need_session_context"] = True
    if _should_need_episode(parsed):
        flags["need_episode"] = True
    if _should_need_routine(parsed, routes):
        flags["need_routine"] = True

    return flags


def _should_need_preference(
    parsed: ParsedInput,
    routes: list[RouteMatch],
    context: dict[str, Any],
) -> bool:
    """True when user-preference memory (Tier 4) is likely relevant."""
    # Route-based: direct_chat and knowledge queries benefit from prefs.
    if any(r.capability in _PREFERENCE_CAPABILITIES for r in routes):
        return True
    # Parse-based: self-referencing pronoun + preference verb.
    lower_text = " ".join(parsed.tokens).lower() if parsed.tokens else ""
    has_self = any(tok in _SELF_PRONOUNS for tok in lower_text.split())
    has_pref = any(lemma in lower_text for lemma in _PREFERENCE_LEMMAS)
    return has_self and has_pref


def _should_need_social(
    parsed: ParsedInput,
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
) -> bool:
    """True when the social/people graph (Tier 5) is likely relevant."""
    # Route-based: people-related capabilities.
    if any(r.capability in _SOCIAL_CAPABILITIES for r in routes):
        return True
    # Extraction-based: PERSON entities found.
    for ext in extractions:
        if any(label == "PERSON" for _, label in ext.entities):
            return True
    # Parse-based: family relation terms in tokens.
    lower_tokens = {tok.lower() for tok in parsed.tokens}
    if lower_tokens & FAMILY_RELATIONS:
        return True
    return False


_DEFINITE_DETERMINERS: frozenset[str] = frozenset({
    "the", "that", "this", "these", "those",
})


def _has_definite_phrase(references: list[str]) -> bool:
    """True when references contain a short definite phrase (det + 1-3 words).

    Catches "the original", "the sequel", "the first one", "the newer one"
    which are contextual references but don't match any pronoun token.
    """
    for ref in references:
        words = ref.lower().split()
        if 2 <= len(words) <= 4 and words[0] in _DEFINITE_DETERMINERS:
            return True
    return False


def _should_need_session_context(
    extractions: list[ChunkExtraction],
) -> bool:
    """True when chunks contain referent pronouns or definite phrases needing session context."""
    for ext in extractions:
        if any(ref in _REFERENT_PRONOUNS for ref in ext.references):
            return True
        if _has_definite_phrase(ext.references):
            return True
    return False


def _should_need_episode(parsed: ParsedInput) -> bool:
    """True when the user references past conversations."""
    lower_text = " ".join(parsed.tokens).lower() if parsed.tokens else ""
    return any(lemma in lower_text for lemma in _EPISODE_LEMMAS)


def _should_need_routine(
    parsed: ParsedInput,
    routes: list[RouteMatch],
) -> bool:
    """True when routine/procedural context (Tier 7) is likely relevant.

    Triggers on routine-related lemmas or direct_chat (where style
    personalization has the highest impact).
    """
    if any(r.capability == "direct_chat" for r in routes):
        return True
    lower_text = " ".join(parsed.tokens).lower() if parsed.tokens else ""
    return any(lemma in lower_text for lemma in _ROUTINE_LEMMAS)


# ---- structured param extraction --------------------------------------------

# NER label → param name mappings for skill parameter extraction.
# Public: also consumed by the router for slot-compatibility scoring.
NER_PARAM_MAP: dict[str, str] = {
    "GPE": "location",    # geopolitical entity → location/city/country
    "LOC": "location",    # named location
    "PERSON": "person",   # person name
    "ORG": "ticker",      # organisation (often stock queries)
}

# Capability → which NER params are relevant.
# Public: also consumed by the router for slot-compatibility scoring.
CAPABILITY_PARAMS: dict[str, tuple[str, ...]] = {
    "get_weather": ("location",),
    "get_forecast": ("location",),
    "time_in_location": ("location",),
    "get_time_in_location": ("location",),
    "get_holidays": ("location",),
    "get_movie_showtimes": ("location",),
    "news_search": ("location", "person"),
    "lookup_person_facts": ("person",),
    "lookup_person_birthday": ("person",),
    "lookup_person_address": ("person",),
    "get_stock_price": ("ticker",),
    "get_stock_info": ("ticker",),
    "get_market_data": ("ticker",),
    "lookup_relationship": ("person",),
    "list_family": ("person",),
    "lookup_movie": ("location",),
    "search_movies": ("location",),
    "get_episode_detail": ("location",),
}


def extract_structured_params(
    chunks: list[RequestChunk],
    extractions: list[ChunkExtraction],
    routes: list[RouteMatch],
) -> dict[int, dict[str, str]]:
    """Extract structured params per chunk from NER entities.

    Returns a dict mapping chunk_index → param dict. Only chunks whose
    routed capability has entries in ``CAPABILITY_PARAMS`` are processed.
    """
    extraction_by_chunk = {ext.chunk_index: ext for ext in extractions}
    out: dict[int, dict[str, str]] = {}

    for route in routes:
        wanted = CAPABILITY_PARAMS.get(route.capability)
        if not wanted:
            continue
        ext = extraction_by_chunk.get(route.chunk_index)
        if not ext or not ext.entities:
            continue
        params: dict[str, str] = {}
        for entity_text, label in ext.entities:
            param_name = NER_PARAM_MAP.get(label)
            if param_name and param_name in wanted and param_name not in params:
                params[param_name] = entity_text
        if params:
            out[route.chunk_index] = params

    return out
