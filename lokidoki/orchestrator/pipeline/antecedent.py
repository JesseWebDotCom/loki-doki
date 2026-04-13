"""Pre-routing antecedent resolution for pronoun-heavy queries.

Replaces subject pronouns ("it", "that", "this") with the most recent
conversational topic so downstream search handlers get a grounded query
instead of a bare pronoun.

Example:
    conversation_history = [
        {"role": "user",      "content": "what is Claude Cowork"},
        {"role": "assistant", "content": "Claude Cowork is a desktop AI ..."},
    ]
    "is it free" → "is Claude Cowork free"

This runs BEFORE routing so that ``_is_factual_wh_question`` promotion
sends "is Claude Cowork free" to ``knowledge_query``, not "is it free".
"""
from __future__ import annotations

import logging
import re
from typing import Any

from lokidoki.orchestrator.core.types import RequestChunk

logger = logging.getLogger("lokidoki.orchestrator.pipeline.antecedent")

_SUBJECT_PRONOUNS = frozenset({"it", "this", "that", "they", "them"})

# Regex matching a leading pronoun that acts as the subject/object
# of a factual question.  Captures: "is it", "does it", "is that",
# "can it", "what is it", "how much does it", etc.
_PRONOUN_RE = re.compile(
    r"\b(it|this|that|they|them)\b",
    re.IGNORECASE,
)


def resolve_antecedents(
    chunks: list[RequestChunk],
    context: dict[str, Any],
) -> list[RequestChunk]:
    """Replace subject pronouns in chunk text with the most recent topic.

    Only acts on chunks whose text is a short factual question containing
    a pronoun.  Returns a new list — never mutates the originals.
    """
    topic = _extract_recent_topic(context)
    if not topic:
        return chunks

    out: list[RequestChunk] = []
    for chunk in chunks:
        resolved_text = _try_resolve(chunk.text, topic)
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


def _try_resolve(text: str, topic: str) -> str:
    """Replace the first subject pronoun in ``text`` with ``topic``.

    Only fires when:
    1. The text is short (< 12 words) — long sentences rarely need this.
    2. The text contains at least one subject pronoun from the closed set.
    """
    words = text.split()
    if len(words) > 12:
        return text
    lower = text.lower()
    if not any(p in lower.split() for p in _SUBJECT_PRONOUNS):
        return text
    # Replace the FIRST occurrence of the pronoun with the topic.
    return _PRONOUN_RE.sub(topic, text, count=1)


def _extract_recent_topic(context: dict[str, Any]) -> str:
    """Pull the dominant topic from the most recent assistant turn.

    Strategy: find the first noun phrase or capitalized multi-word span
    in the assistant's last response. Falls back to the user's last
    question's object.
    """
    history = context.get("conversation_history") or []
    if not history:
        return ""

    # Walk backwards to find the last assistant message
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

    # Strategy 1: Extract the subject of the assistant's first sentence.
    # "Claude Cowork is a desktop AI agent..." → "Claude Cowork"
    if last_assistant:
        topic = _first_noun_phrase(last_assistant)
        if topic:
            return topic

    # Strategy 2: Extract from the user's last question.
    # "what is Claude Cowork" → "Claude Cowork"
    if last_user:
        topic = _question_object(last_user)
        if topic:
            return topic

    return ""


def _first_noun_phrase(text: str) -> str:
    """Extract the leading noun phrase from text using a simple heuristic.

    Looks for a sequence of capitalized words at the start of a sentence.
    "Claude Cowork is a desktop AI..." → "Claude Cowork"
    """
    # Take first sentence
    first_sentence = re.split(r"[.!?]", text, maxsplit=1)[0].strip()
    if not first_sentence:
        return ""
    # Find leading capitalized words (the subject)
    words = first_sentence.split()
    noun_phrase: list[str] = []
    for word in words:
        # Stop at verbs / function words that signal end of subject NP
        clean = word.strip(",'\"()[]")
        if clean and clean[0].isupper():
            noun_phrase.append(clean)
        elif noun_phrase:
            break
        else:
            # Skip leading lowercase words like "the" before the proper noun
            continue
    if noun_phrase:
        result = " ".join(noun_phrase)
        # Don't return single-char or very short results
        if len(result) > 2:
            return result
    return ""


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
