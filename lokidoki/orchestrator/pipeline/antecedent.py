"""Pre-routing antecedent resolution for pronoun-heavy queries.

This is the design-spec "resolve" step that runs BEFORE routing.  It
replaces subject pronouns ("he", "she", "it", "that") with the most
recently tracked entity from session state so downstream routing and
search handlers get a grounded query instead of a bare pronoun.

Entity source priority:
  1. Session state ``last_seen`` map (via ``context["recent_entities"]``,
     populated by ``bridge_session_state_to_recent_entities``).
  2. Conversation history text (fallback when session state has no entity,
     e.g. first turn of a session or entity not formally tracked).

Additionally extracts a **conversational topic** (e.g. "The Masked
Singer" when the entity is "Corey Feldman") and stores it in
``context["conversation_topic"]`` so the knowledge-query handler can
build richer search queries.

Example:
    session state: last_person = "Corey Feldman"
    recent topic:  "The Masked Singer"
    "did he win" → chunk text "did Corey Feldman win"
                 → context["conversation_topic"] = "The Masked Singer"
                 → search query "did Corey Feldman win The Masked Singer"
"""
from __future__ import annotations

import logging
import re
from typing import Any

from lokidoki.orchestrator.core.types import RequestChunk

logger = logging.getLogger("lokidoki.orchestrator.pipeline.antecedent")

# Pronouns the resolver will attempt to replace with the recent entity.
# Split into categories so substitution can handle possessives correctly
# ("his" → "Corey Feldman's", not "Corey Feldman").
_SUBJECT_OBJECT_PRONOUNS = frozenset({
    "it", "this", "that", "they", "them",
    "he", "she", "him", "her",
})
_POSSESSIVE_PRONOUNS = frozenset({"his", "hers"})
_ALL_PRONOUNS = _SUBJECT_OBJECT_PRONOUNS | _POSSESSIVE_PRONOUNS

# Regex matching any resolvable pronoun in the text.
_PRONOUN_RE = re.compile(
    r"\b(it|this|that|they|them|he|she|him|her|his|hers)\b",
    re.IGNORECASE,
)

# Demonstrative pronouns that can also act as determiners before a noun.
# "that movie" = determiner (leave for post-routing resolver).
# "tell me about that" = pronoun (substitute here).
_DEMONSTRATIVES = frozenset({"this", "that", "these", "those"})

# Entity-type nouns that signal a demonstrative is a determiner.
_ENTITY_TYPE_NOUNS = frozenset({
    "movie", "film", "show", "series", "song", "track", "album",
    "book", "game", "app", "device", "phone", "recipe", "person",
    "place", "episode", "video", "podcast", "article", "word",
    "thing", "one", "guy", "girl", "man", "woman", "kid", "team",
})


def resolve_antecedents(
    chunks: list[RequestChunk],
    context: dict[str, Any],
) -> list[RequestChunk]:
    """Replace subject pronouns in chunk text with the most recent entity.

    Uses session-state entities (``context["recent_entities"]``) when
    available; falls back to conversation-history parsing otherwise.

    Only substitutes **person pronouns** (he/she/him/her/his/hers)
    unconditionally. Generic pronouns (it/this/that) are left for the
    post-routing media/pronoun resolver when session state contains a
    movie entity — the media resolver has capability-specific logic for
    those.

    Side-effect: stores ``context["conversation_topic"]`` when a topic
    beyond the main entity is detected.  Downstream handlers
    (knowledge_query) use this to build richer search queries.
    """
    entity, conv_topic = _resolve_entity_and_topic(context)
    if not entity:
        return chunks

    if conv_topic:
        context["conversation_topic"] = conv_topic

    # If session state has a movie entity, generic pronouns (it/this/that)
    # should be deferred to the post-routing media resolver.
    has_movie = _has_entity_type(context, "movie")

    out: list[RequestChunk] = []
    for chunk in chunks:
        resolved_text = _try_resolve(chunk.text, entity, defer_generic=has_movie)
        if resolved_text != chunk.text:
            logger.info(
                "[Antecedent] Resolved chunk %d: '%s' → '%s'",
                chunk.index, chunk.text, resolved_text,
            )
            out.append(RequestChunk(
                text=resolved_text,
                index=chunk.index,
                role=chunk.role,
                span_start=chunk.span_start,
                span_end=chunk.span_end,
            ))
        else:
            out.append(chunk)
    return out


def _has_entity_type(context: dict[str, Any], entity_type: str) -> bool:
    """Check if recent_entities contains an entity of the given type."""
    for item in context.get("recent_entities") or []:
        if isinstance(item, dict) and str(item.get("type", "")).lower() == entity_type:
            return True
    return False


# Pronouns that always refer to persons — safe to substitute pre-routing.
_PERSON_PRONOUNS = frozenset({
    "he", "she", "him", "her", "his", "hers",
})

# Generic pronouns that may refer to movies/media — deferred when a
# movie entity is in session state so the media resolver can handle them.
_GENERIC_PRONOUNS = frozenset({
    "it", "this", "that", "they", "them",
})


def _try_resolve(text: str, entity: str, *, defer_generic: bool = False) -> str:
    """Replace the first subject pronoun in ``text`` with ``entity``.

    Only fires when:
    1. The text contains at least one subject pronoun from the closed set.
    2. The pronoun is a standalone referent, NOT a determiner before a noun
       (e.g. "that movie" is left for the post-routing media resolver).
    3. If ``defer_generic`` is True, generic pronouns (it/this/that/they/
       them) are skipped — the post-routing media resolver handles those.
    4. The current chunk does not already contain a same-type proper-noun
       antecedent for the pronoun — a sentence that introduces a new named
       person ("Tell me about Obi-Wan. Is he a Jedi?") should resolve against
       the *in-chunk* antecedent, not the historical session entity.
    """
    lower = text.lower()
    words_lower = lower.split()
    if not any(p in words_lower for p in _ALL_PRONOUNS):
        return text
    match = _PRONOUN_RE.search(text)
    if not match:
        return text
    pronoun = match.group(1).lower()
    # Demonstrative + entity-type noun = determiner ("that movie").
    if pronoun in _DEMONSTRATIVES and _is_determiner(text, match):
        return text
    # Defer generic pronouns when a movie entity exists in session state.
    if defer_generic and pronoun in _GENERIC_PRONOUNS:
        return text
    # If the chunk itself contains a proper noun *before* the pronoun, the
    # user likely means that in-chunk antecedent, not the session entity.
    if _has_in_chunk_antecedent(text, match, entity):
        return text
    replacement = f"{entity}'s" if pronoun in _POSSESSIVE_PRONOUNS else entity
    return _PRONOUN_RE.sub(replacement, text, count=1)


def _has_in_chunk_antecedent(text: str, match: re.Match, entity: str) -> bool:
    """Return True if ``text`` introduces a new proper noun before the pronoun
    that plausibly outranks the session entity as the antecedent.

    Conservative: only trips when the in-chunk proper noun is a different
    entity than the session one, to avoid over-blocking normal follow-ups.
    """
    before = text[: match.start()]
    phrases = _all_proper_noun_phrases(before)
    if not phrases:
        return False
    entity_lower = entity.lower()
    for phrase in phrases:
        if phrase.lower() != entity_lower and phrase.lower() not in entity_lower:
            return True
    return False


def _is_determiner(text: str, match: re.Match) -> bool:
    """Check if a demonstrative pronoun is actually a determiner before a noun."""
    after = text[match.end():].lstrip()
    if not after:
        return False
    next_word = after.split()[0].strip(".,!?;:'\"").lower()
    return next_word in _ENTITY_TYPE_NOUNS


# ---------------------------------------------------------------------------
# Entity + topic resolution
# ---------------------------------------------------------------------------

def _resolve_entity_and_topic(context: dict[str, Any]) -> tuple[str, str]:
    """Resolve the entity (for pronoun substitution) and conversational topic.

    Returns ``(entity, topic)`` where:
    - ``entity`` is the subject name ("Corey Feldman") for pronoun replacement.
    - ``topic`` is the broader conversational context ("The Masked Singer")
      for downstream search enrichment.

    Resolution sources (in priority order):
    1. Session state ``recent_entities`` (populated by the bridge hook).
    2. Conversation history text (fallback).
    """
    entity = ""
    topic = ""

    # --- Source 1: session state entities ---
    recent = context.get("recent_entities") or []
    if recent:
        entity, topic = _entity_from_session_state(recent)

    # --- Source 2: conversation history (fallback for entity) ---
    if not entity:
        entity, hist_topic = _entity_from_conversation_history(context)
        if not topic and hist_topic:
            topic = hist_topic

    # --- Source 3: conversation history (fallback for topic only) ---
    if entity and not topic:
        _, hist_topic = _entity_from_conversation_history(context)
        if hist_topic:
            topic = hist_topic

    return entity, topic


def _entity_from_session_state(
    recent: list[dict[str, Any]],
) -> tuple[str, str]:
    """Extract entity and topic from ``context["recent_entities"]``.

    The list is populated by ``bridge_session_state_to_recent_entities``
    from the session's ``last_seen`` map.  Each entry is a dict with
    ``name`` and ``type`` keys.

    Returns ``(entity, topic)`` — entity is the first person (or first
    entity if no person), topic is the first entry with type ``topic``.
    """
    entity = ""
    topic = ""
    first_name = ""

    for item in recent:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        etype = str(item.get("type") or "").lower()
        if not name:
            continue
        if not first_name:
            first_name = name
        if etype == "person" and not entity:
            entity = name
        if etype == "topic" and not topic:
            topic = name

    # If no person entity, use whatever entity we found first.
    if not entity:
        entity = first_name

    return entity, topic


def _entity_from_conversation_history(
    context: dict[str, Any],
) -> tuple[str, str]:
    """Fallback: extract entity + topic from conversation history text.

    Used when session state has no recent entities (e.g. first turn, or
    entities not formally tracked by the session-state update hook).
    """
    history = context.get("conversation_history") or []
    if not history:
        return "", ""

    last_assistant = ""
    last_user = ""
    for msg in reversed(history):
        role = msg.get("role", "")
        content = msg.get("content", "").strip()
        if role == "assistant" and not last_assistant:
            last_assistant = content
        if role == "user" and not last_user:
            last_user = content
        if last_assistant and last_user:
            break

    entity = ""
    topic = ""

    if last_assistant:
        proper_nouns = _all_proper_noun_phrases(last_assistant)
        if proper_nouns:
            entity = proper_nouns[0]
            if len(proper_nouns) > 1:
                topic = proper_nouns[1]

    if not entity and last_user:
        entity = _question_object(last_user)

    if not topic and last_user:
        user_topic = _extract_user_topic(last_user, entity)
        if user_topic:
            topic = user_topic

    return entity, topic


# ---------------------------------------------------------------------------
# Text extraction helpers
# ---------------------------------------------------------------------------

def _all_proper_noun_phrases(text: str) -> list[str]:
    """Extract all proper-noun phrases from the first sentence of ``text``.

    A proper-noun phrase is a contiguous run of capitalized words.

    >>> _all_proper_noun_phrases(
    ...     "Corey Feldman was on The Masked Singer in 2024."
    ... )
    ['Corey Feldman', 'The Masked Singer']
    """
    first_sentence = re.split(r"[.!?]", text, maxsplit=1)[0].strip()
    if not first_sentence:
        return []
    words = first_sentence.split()
    results: list[str] = []
    current: list[str] = []
    for word in words:
        clean = word.strip(",'\"()[]")
        if clean and clean[0].isupper() and clean.isalpha():
            current.append(clean)
        else:
            if current:
                phrase = " ".join(current)
                if len(phrase) > 2:
                    results.append(phrase)
                current = []
    if current:
        phrase = " ".join(current)
        if len(phrase) > 2:
            results.append(phrase)
    return results


def _first_noun_phrase(text: str) -> str:
    """Extract the leading proper-noun phrase from text."""
    phrases = _all_proper_noun_phrases(text)
    return phrases[0] if phrases else ""


def _extract_user_topic(user_text: str, entity: str) -> str:
    """Extract a topical phrase from the user's last question.

    Strips question words and pronouns, then looks for a trailing
    noun-phrase that isn't the entity.

    "what year was he on the masked singer" → "the masked singer"
    """
    q = user_text.strip().rstrip("?. ")
    q = re.sub(
        r"^(?:what|who|where|when|how|did|does|is|was|were|are|can|will)\s+",
        "", q, flags=re.IGNORECASE,
    )
    q = re.sub(
        r"\b(?:he|she|him|her|his|hers|it|they|them|their|this|that)\b",
        "", q, flags=re.IGNORECASE,
    )
    q = re.sub(
        r"\b(?:is|was|were|are|did|does|do|has|have|had|win|get|go)\b",
        "", q, flags=re.IGNORECASE,
    )
    q = " ".join(q.split()).strip()
    if not q or len(q) <= 2:
        return ""
    if entity and q.lower() == entity.lower():
        return ""
    return q


def _question_object(text: str) -> str:
    """Extract the object of a WH-question.

    "what is Claude Cowork" → "Claude Cowork"
    "who is Alan Turing" → "Alan Turing"
    """
    q = text.strip().rstrip("?. ")
    patterns = [
        r"^(?:what|who)\s+(?:is|are|was|were)\s+(.+)$",
        r"^(?:what's)\s+(.+)$",
        r"^(?:tell me about)\s+(.+)$",
    ]
    for pattern in patterns:
        match = re.match(pattern, q, re.IGNORECASE)
        if match:
            obj = match.group(1).strip()
            if obj and len(obj) > 2:
                return obj
    return ""
