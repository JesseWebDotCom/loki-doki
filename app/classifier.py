"""Request classification for Phase 3 text routing."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import get_close_matches

from app.local_routes import is_static_text_match, match_command

COMPLEX_KEYWORDS = {
    "plan",
    "compare",
    "analyze",
    "debug",
    "summarize",
    "explain",
    "architecture",
}
WEB_KEYWORDS = {
    "age",
    "born",
    "current",
    "events",
    "latest",
    "movies",
    "news",
    "president",
    "old",
    "playing",
    "search",
    "showtimes",
    "theater",
    "theatre",
    "tonight",
    "today",
    "weather",
}
TOOL_KEYWORDS = {"calendar", "open", "settings", "system", "timer"}
ROUTER_VOCABULARY = COMPLEX_KEYWORDS | WEB_KEYWORDS | TOOL_KEYWORDS
FUZZY_MIN_LENGTH = 5
FUZZY_CUTOFF = 0.84


@dataclass(frozen=True)
class Classification:
    """Classifier output."""

    request_type: str
    route: str
    reason: str


def classify_message(message: str) -> Classification:
    """Return a simple keyword-based classification."""
    cleaned = message.strip().lower()
    if is_static_text_match(cleaned):
        return Classification("static_text", "static_text", "Matched a canned local text response.")
    command = match_command(cleaned)
    if command is not None:
        return Classification("command_call", "local_command", command.reason)
    words = _normalized_words(cleaned)
    if _is_image_generation_query(cleaned, sorted(list(words))):
        return Classification("image_generation", "image_generator", "Matched an image generation request.")
    if _is_web_query(cleaned, words):
        return Classification("web_query", "web_search", "Matched a live-information web query.")
    if words & TOOL_KEYWORDS:
        return Classification("tool_call", "function_model", "Matched a local tool-capable request.")
    if len(cleaned.split()) > 15 or words & COMPLEX_KEYWORDS:
        return Classification("text_chat", "thinking_qwen", "Long or complex prompt.")
    return Classification("text_chat", "fast_qwen", "Default conversational route.")


def _is_image_generation_query(cleaned: str, words: list[str]) -> bool:
    """Return whether a request should route to the image generator."""
    prefixes = (
        "create an image ",
        "generate an image ",
        "draw a ",
        "draw an ",
        "paint a ",
        "paint an ",
        "make an image ",
        "make a picture ",
        "turn this into ",
        "make this look like ",
        "change this into ",
        "edit this image ",
        "modify this picture ",
    )
    if cleaned.startswith(prefixes):
        return True
    
    gen_verbs = {"generate", "create", "draw", "paint"}
    img_nouns = {"image", "picture", "photo", "drawing", "painting", "pic"}
    if bool(set(words) & gen_verbs) and bool(set(words) & img_nouns):
        return True
        
    edit_verbs = {"edit", "modify", "transform"}
    return bool(set(words) & edit_verbs) and bool(set(words) & img_nouns)


def _is_web_query(cleaned: str, words: set[str]) -> bool:
    """Return whether a request should route through the web-search lane."""
    if "search the web" in cleaned or "search online" in cleaned:
        return True
    if "current events" in cleaned or "latest news" in cleaned:
        return True
    if cleaned.startswith("how old is ") or cleaned.startswith("how old was "):
        return True
    if _is_direct_lookup(cleaned, words):
        return True
    if _looks_like_live_lookup(cleaned, words):
        return True
    if " age " in f" {cleaned} " or cleaned.startswith("age of "):
        return True
    if _is_office_holder_query(cleaned):
        return True
    return bool(words & WEB_KEYWORDS) and any(
        keyword in words
        for keyword in (
            "age",
            "born",
            "current",
            "latest",
            "movies",
            "news",
            "old",
            "playing",
            "president",
            "showtimes",
            "theater",
            "theatre",
            "today",
            "tonight",
            "weather",
        )
    )


def _normalized_words(cleaned: str) -> set[str]:
    """Return tokenized words with light typo normalization for router keywords."""
    words = set(cleaned.replace("?", " ").replace(",", " ").split())
    normalized = set(words)
    for word in words:
        if len(word) < FUZZY_MIN_LENGTH:
            continue
        match = get_close_matches(word, list(ROUTER_VOCABULARY), n=1, cutoff=FUZZY_CUTOFF)
        if match:
            normalized.add(match[0])
    return normalized


def _is_office_holder_query(cleaned: str) -> bool:
    """Return whether a prompt is asking for a current office holder."""
    prefixes = (
        "who is president",
        "who is the president",
        "who is current president",
        "who is the current president",
    )
    return cleaned.startswith(prefixes)


def _looks_like_live_lookup(cleaned: str, words: set[str]) -> bool:
    """Return whether a prompt reads like a factual or product lookup."""
    if _has_lookup_prefix(cleaned):
        if len(words) >= 8:
            return True
        if _has_recentness_hint(words):
            return True
        if _has_reference_pattern(cleaned, words):
            return True
    if _has_embedded_lookup_phrase(cleaned) and len(words) >= 8:
        return True
    return ":" in cleaned and any(char.isdigit() for char in cleaned)


def _has_lookup_prefix(cleaned: str) -> bool:
    """Return whether a prompt begins like an information lookup."""
    return cleaned.startswith(
        (
            "who is ",
            "who was ",
            "what is ",
            "what are ",
            "what was ",
            "which ",
            "does ",
            "is there ",
            "are there ",
            "has ",
            "have ",
            "where can i ",
            "i need ",
        )
    )


def _is_direct_lookup(cleaned: str, words: set[str]) -> bool:
    """Return True if this is a direct factual lookup that needs the web."""
    if not _has_lookup_prefix(cleaned):
        return False
    # If it's just 'who is he' or 'what is that', it's a follow-up, not a new lookup.
    pronouns = {"he", "she", "it", "they", "them", "him", "her", "this", "that"}
    subject_words = set(cleaned.split()[2:])
    if subject_words and subject_words.issubset(pronouns):
        return False
    return True


def _has_embedded_lookup_phrase(cleaned: str) -> bool:
    """Return whether a request contains a lookup-style sub-question."""
    return any(
        phrase in cleaned
        for phrase in (
            " did any ",
            " did any of the ",
            " has anyone ",
            " have any ",
            " ever mention ",
        )
    )


def _has_recentness_hint(words: set[str]) -> bool:
    """Return whether a request implies changing or time-sensitive facts."""
    return bool(words & {"current", "latest", "new", "recent", "recently", "today", "tonight", "tomorrow", "changed"})


def _has_reference_pattern(cleaned: str, words: set[str]) -> bool:
    """Return whether a request contains model-like identifiers."""
    if ":" in cleaned and any(char.isdigit() for char in cleaned):
        return True
    return any(any(char.isalpha() for char in word) and any(char.isdigit() for char in word) for word in words)
