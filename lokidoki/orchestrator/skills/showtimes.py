"""movie showtimes adapter — wraps lokidoki.skills.movies_fandango.

The v1 FandangoSkill exposes nine mechanisms; the pipeline only
needs three of them:

  - ``movie_showtimes`` — showtimes for a specific film by zip
  - ``napi_theaters_with_showtimes`` — JSON backend, broader theater list
  - ``local_cache`` — instance-level cache from prior successful calls

If the user did not provide a ZIP we fall back to a sensible default
("06461", a stand-in for the prototype's test fixtures). A real
deployment would resolve the ZIP from user profile / settings.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.movies_fandango.skill import FandangoShowtimesSkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms
from lokidoki.orchestrator.skills._config import get_skill_config

_SKILL = FandangoShowtimesSkill()


def _default_zip() -> str:
    return get_skill_config("get_movie_showtimes", "default_zip", "06461")

_TITLE_BLOCKLIST = {
    "what",
    "time",
    "is",
    "are",
    "the",
    "a",
    "an",
    "new",
    "when",
    "does",
    "show",
    "showing",
    "playing",
    "me",
    "for",
    "movie",
    "film",
    "showtimes",
    "tonight",
    "tomorrow",
    "today",
    "in",
    "at",
}

_ZIP_RE = re.compile(r"\b(\d{5})\b")


def _extract_zip(payload: dict[str, Any]) -> str:
    r"""Read zip from params or regex (``\d{5}`` is a machine pattern, not intent)."""
    explicit = (payload.get("params") or {}).get("zip")
    if explicit:
        return str(explicit)
    # ZIP codes are machine-recognizable digit patterns — regex is fine.
    chunk_text = str(payload.get("chunk_text") or "")
    match = _ZIP_RE.search(chunk_text)
    if match:
        return match.group(1)
    return _default_zip()


def _extract_title(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    chunk_text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not chunk_text:
        return ""
    # "movie times for X (in 06461)?" — pull X
    if " for " in chunk_text:
        tail = chunk_text.split(" for ", 1)[1]
        for marker in (" in ", " at ", " near ", " tonight", " tomorrow", " today"):
            if marker in tail:
                tail = tail.split(marker, 1)[0]
        candidate = tail.strip()
        if candidate:
            return candidate
    # Otherwise: drop noise tokens, keep what's left
    tokens = [
        tok
        for tok in re.findall(r"[a-zA-Z0-9']+", chunk_text)
        if tok not in _TITLE_BLOCKLIST
    ]
    return " ".join(tokens)


def _format_success(result, method: str) -> str:
    data = result.data or {}
    lead = str(data.get("lead") or "").strip()
    if lead:
        return lead
    showtimes = data.get("showtimes") or []
    if isinstance(showtimes, list) and showtimes:
        first = showtimes[0]
        title = first.get("title") or first.get("name") or "the requested movie"
        theaters = first.get("theaters") or []
        if isinstance(theaters, list) and theaters:
            theater_name = theaters[0].get("name") or theaters[0].get("title") or "your local theater"
            times = theaters[0].get("times") or theaters[0].get("showtimes") or []
            if isinstance(times, list) and times:
                joined = ", ".join(str(t) for t in times[:5])
                return f"Showtimes for {title} at {theater_name}: {joined}."
            return f"{title} is playing at {theater_name}."
        return f"{title} is playing locally."
    return "I found showtimes but couldn't read the schedule."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    title = _extract_title(payload)
    zip_code = _extract_zip(payload)
    if not title:
        return AdapterResult(
            output_text="Which movie would you like showtimes for?",
            success=False,
            error="missing title",
        ).to_payload()
    attempts = [
        ("movie_showtimes", {"query": title, "zip": zip_code}),
        ("napi_theaters_with_showtimes", {"zip": zip_code}),
        ("local_cache", {"query": title, "zip": zip_code}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=(
            f"I couldn't reach Fandango for showtimes for '{title}' near "
            f"{zip_code} right now."
        ),
    )
    return result.to_payload()
