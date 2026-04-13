"""dictionary adapter — wraps lokidoki.skills.dictionary.

The DictionarySkill is a single-mechanism wrapper around
dictionaryapi.dev. There is no offline fallback, so the
adapter degrades gracefully when the network is down.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.dictionary.skill import DictionarySkill

from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = DictionarySkill()

_LEAD_VERBS = ("define ", "definition of ", "what does ", "meaning of ", "what is the meaning of ")


def _extract_word(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("word")
    if explicit:
        return str(explicit)
    text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not text:
        return ""
    for verb in _LEAD_VERBS:
        if text.startswith(verb):
            tail = text[len(verb):].strip()
            if tail.endswith(" mean"):
                tail = tail[: -len(" mean")].strip()
            return tail.split()[0] if tail else ""
    # Fallback: assume the chunk is just a single word.
    tokens = re.findall(r"[a-zA-Z'-]+", text)
    return tokens[-1] if tokens else ""


def _format_success(result, method: str) -> str:
    data = result.data or {}
    word = data.get("word") or "the word"
    meanings = data.get("meanings") or []
    if not meanings:
        return f"I found {word} in the dictionary but couldn't read its definition."
    first = meanings[0]
    pos = first.get("part_of_speech") or ""
    defs = first.get("definitions") or []
    if not defs:
        return f"I found {word} but no definition was returned."
    primary = defs[0].rstrip(".")
    if pos:
        return f"{word} ({pos}): {primary}."
    return f"{word}: {primary}."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    word = _extract_word(payload)
    if not word:
        return AdapterResult(
            output_text="Which word would you like me to define?",
            success=False,
            error="missing word",
        ).to_payload()
    attempts = [("dictionaryapi_dev", {"word": word})]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=f"I couldn't reach the dictionary service to look up '{word}'.",
    )
    return result.to_payload()
