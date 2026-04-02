"""Local Tier 0 text and command routing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
from typing import Optional


SIMPLE_QUERIES = {
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "how are you",
    "how are you doing",
    "good morning",
    "good afternoon",
    "good evening",
    "what is your name",
    "what's your name",
    "tell me your name",
}
SIMPLE_PREFIXES = (
    "hi ",
    "hello ",
    "hey ",
    "how are you",
    "how's it going",
    "whats up",
    "what's up",
    "who are you",
    "what is your name",
    "what's your name",
    "tell me your name",
    "what can you do",
    "good morning",
    "good afternoon",
    "good evening",
)
TIME_PATTERNS = (
    re.compile(r"^(what time is it|what'?s the time|current time)\??$"),
    re.compile(r"^(tell me the time)\??$"),
)
DATE_PATTERNS = (
    re.compile(r"^(what('?s| is) (today'?s|the) date|what day is it|current date)\??$"),
    re.compile(r"^(tell me (today'?s|the) date)\??$"),
)
PROFILE_PATTERNS = (
    re.compile(r"^(what profile are you on|which profile are you on|current profile)\??$"),
    re.compile(r"^(what runtime profile are you using)\??$"),
)


@dataclass(frozen=True)
class CommandMatch:
    """Matched local command metadata."""

    name: str
    reason: str


def is_static_text_match(message: str) -> bool:
    """Return whether a message can be answered by a canned local reply."""
    cleaned = _normalize(message)
    if cleaned in SIMPLE_QUERIES:
        return True
    if any(cleaned.startswith(prefix) for prefix in SIMPLE_PREFIXES):
        return len(cleaned.split()) <= 6
    return False


def match_command(message: str) -> Optional[CommandMatch]:
    """Return a matched local command when one is supported."""
    cleaned = _normalize(message)
    if _matches_any(cleaned, TIME_PATTERNS):
        return CommandMatch(name="time_lookup", reason="Matched a local time command.")
    if _matches_any(cleaned, DATE_PATTERNS):
        return CommandMatch(name="date_lookup", reason="Matched a local date command.")
    if _matches_any(cleaned, PROFILE_PATTERNS):
        return CommandMatch(name="profile_lookup", reason="Matched a local profile command.")
    return None


def run_command(message: str, profile: str) -> str:
    """Execute a supported local command and return a reply."""
    command = match_command(message)
    if command is None:
        raise ValueError("Unsupported local command.")
    now = datetime.now()
    if command.name == "time_lookup":
        return f"The current local time is {now.strftime('%I:%M %p').lstrip('0')}."
    if command.name == "date_lookup":
        return f"Today is {now.strftime('%A, %B')} {now.day}, {now.year}."
    return f"The active runtime profile is {profile}."


def _normalize(message: str) -> str:
    """Normalize user text before local route matching."""
    return " ".join(message.strip().lower().split())


def _matches_any(message: str, patterns: tuple[re.Pattern[str], ...]) -> bool:
    """Return whether a normalized message matches any local command pattern."""
    return any(pattern.match(message) for pattern in patterns)
