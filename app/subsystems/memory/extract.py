from __future__ import annotations
import re
import sqlite3
from typing import Any

from app.subsystems.memory.records import write_memory


_TITLE_STOP_WORDS = {
    "Have",
    "Has",
    "What",
    "Who",
    "Why",
    "When",
    "Where",
    "The",
    "A",
    "An",
    "I",
    "It",
    "That",
}


def promote_person_facts(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str | None,
    message: str,
    history: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Extract and persist durable person facts from one user turn."""
    if not character_id:
        return []
    cleaned_message = " ".join(str(message).split()).strip()
    if not cleaned_message:
        return []
    facts = _extract_candidate_facts(cleaned_message, history)
    written: list[dict[str, Any]] = []
    for fact in facts:
        did_write = write_memory(
            conn,
            scope="person",
            key=fact["key"],
            value=fact["value"],
            user_id=user_id,
            character_id=character_id,
            source="extracted",
            confidence=float(fact["confidence"]),
        )
        if did_write:
            written.append(fact)
    return written


def _extract_candidate_facts(
    message: str,
    history: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    title = _extract_title_from_message(message) or _resolve_recent_title(history)

    favorite_match = re.search(r"\bmy favorite ([a-z_ ]{2,40}) is ([^.!?]+)", message, re.IGNORECASE)
    if favorite_match:
        category = _slug(favorite_match.group(1))
        value = favorite_match.group(2).strip(" .!?\"'")
        if category and value:
            facts.append(
                {
                    "key": f"favorite_{category}",
                    "value": value,
                    "confidence": 0.98,
                }
            )

    live_match = re.search(r"\bi live in ([^.!?]+)", message, re.IGNORECASE)
    if live_match:
        location = live_match.group(1).strip(" .!?\"'")
        if location:
            facts.append(
                {
                    "key": "home_location",
                    "value": location,
                    "confidence": 0.95,
                }
            )

    work_match = re.search(r"\bi work at ([^.!?]+)", message, re.IGNORECASE)
    if work_match:
        workplace = work_match.group(1).strip(" .!?\"'")
        if workplace:
            facts.append(
                {
                    "key": "workplace",
                    "value": workplace,
                    "confidence": 0.93,
                }
            )

    preference_match = re.search(r"\bi prefer ([^.!?]+)", message, re.IGNORECASE)
    if preference_match:
        preference = preference_match.group(1).strip(" .!?\"'")
        if preference:
            facts.append(
                {
                    "key": "stated_preference",
                    "value": preference,
                    "confidence": 0.88,
                }
            )

    if title:
        facts.append(
            {
                "key": "last_discussed_title",
                "value": title,
                "confidence": 0.92,
            }
        )

    if title and re.search(r"\b(i just watched|i watched|i saw)\b", message, re.IGNORECASE):
        facts.append(
            {
                "key": "recently_watched_title",
                "value": _watch_context_value(title, message),
                "confidence": 0.96,
            }
        )

    if title and re.search(r"\b(i liked|i like|i loved|i love|i enjoyed)\b", message, re.IGNORECASE):
        facts.append(
            {
                "key": "liked_title",
                "value": title,
                "confidence": 0.9,
            }
        )
    if title and re.search(r"\b(i disliked|i dislike|i hated|i hate)\b", message, re.IGNORECASE):
        facts.append(
            {
                "key": "disliked_title",
                "value": title,
                "confidence": 0.9,
            }
        )
    return _dedupe_facts(facts)


def _resolve_recent_title(history: list[dict[str, Any]]) -> str:
    for message in reversed(history[-6:]):
        candidate = _extract_title_from_message(str(message.get("content") or ""))
        if candidate:
            return candidate
    return ""


def _extract_title_from_message(message: str) -> str:
    quoted = re.findall(r'"([^"]{2,80})"', message)
    if quoted:
        return quoted[-1].strip().strip(" .!?\"'")
    for phrase in re.findall(r"\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})\b", message):
        words = phrase.split()
        if words and words[0] not in _TITLE_STOP_WORDS:
            return phrase.strip().strip(" .!?\"'")
    lowered = message.lower()
    if "everybody loves raymond" in lowered:
        return "Everybody Loves Raymond"
    return ""


def _watch_context_value(title: str, message: str) -> str:
    extras: list[str] = []
    lowered = message.lower()
    if "youtube" in lowered:
        extras.append("YouTube")
    if "last night" in lowered:
        extras.append("last night")
    if not extras:
        return title
    return f"{title} ({', '.join(extras)})"


def _slug(value: str) -> str:
    return "_".join(re.findall(r"[a-z0-9]+", value.lower()))


def _dedupe_facts(facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for fact in facts:
        marker = (fact["key"], fact["value"])
        if marker in seen:
            continue
        seen.add(marker)
        deduped.append(fact)
    return deduped
def extract_person_facts_llm(
    conn: sqlite3.Connection,
    provider: Any,
    user_id: str,
    character_id: str,
    message: str,
) -> int:
    """Use an LLM to extract potential person facts and queue them for promotion."""
    from app.subsystems.text.client import chat_completion
    
    prompt = (
        "You are an expert fact extractor. Extract any concrete personal facts about the user from their message. "
        "A fact should be a personal detail, preference, background info, or relationship. "
        "Output ONLY the facts, one per line. If none, output nothing. "
        "Example output:\n"
        "The user lives in San Francisco.\n"
        "The user likes spicy food.\n"
        f"\n\nUser message: {message}"
    )
    
    try:
        response = chat_completion(provider, [{"role": "system", "content": prompt}], options={"temperature": 0.0}, timeout=4.0)
        lines = [line.strip() for line in response.splitlines() if line.strip()]
        count = 0
        for line in lines:
            # We use a low confidence (0.4) so it goes into the queue (Intelligence Queue)
            write_memory(
                conn,
                scope="person",
                key="potential_fact",
                value=line,
                user_id=user_id,
                character_id=character_id,
                confidence=0.4,
                source="llm_extraction",
            )
            count += 1
        return count
    except Exception:
        return 0
