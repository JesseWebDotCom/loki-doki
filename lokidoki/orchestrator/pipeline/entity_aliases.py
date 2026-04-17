"""Entity alias canonicalization.

Replaces known shorthand and slang in user text and entity lists with
their canonical forms. Aliases are loaded from
``data/entity_aliases.json`` (user-extensible).
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

logger = logging.getLogger("lokidoki.orchestrator.pipeline.entity_aliases")

_ALIAS_PATH = Path(__file__).with_name("entity_aliases.json")


def _load_aliases() -> dict[str, str]:
    """Load alias map from disk. Returns empty dict on failure."""
    try:
        if _ALIAS_PATH.exists():
            return json.loads(_ALIAS_PATH.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to load entity aliases from %s", _ALIAS_PATH)
    return {}


# Cached at import time.
_ALIASES: dict[str, str] = _load_aliases()

# Pre-compiled regex for word-boundary replacement (rebuilt if aliases change).
_ALIAS_RE: re.Pattern[str] | None = None


def _build_regex() -> re.Pattern[str] | None:
    if not _ALIASES:
        return None
    # Sort by length descending so longer aliases match first.
    escaped = [re.escape(k) for k in sorted(_ALIASES, key=len, reverse=True)]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)


_ALIAS_RE = _build_regex()


def canonicalize_entities(
    text: str,
    entities: list[tuple[str, str]],
) -> tuple[str, list[tuple[str, str]]]:
    """Replace known aliases in *text* and *entities* with canonical forms.

    Returns the updated text and a new entity list with alias surface
    forms replaced by their canonical names.
    """
    if not _ALIASES or _ALIAS_RE is None:
        return text, entities

    def _replace(match: re.Match[str]) -> str:
        return _ALIASES[match.group(0).lower()]

    new_text = _ALIAS_RE.sub(_replace, text)

    new_entities: list[tuple[str, str]] = []
    for surface, label in entities:
        canonical = _ALIASES.get(surface.lower())
        new_entities.append((canonical, label) if canonical else (surface, label))

    return new_text, new_entities
