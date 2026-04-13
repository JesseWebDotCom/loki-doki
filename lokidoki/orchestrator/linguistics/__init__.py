"""Shared linguistic constants for the orchestrator.

These are intrinsic properties of English (closed word classes,
canonical conjunctions, finite-verb auxiliaries, number words) — not
project-specific configuration. Centralizing them here means the
splitter, extractor, fast lane, and pronoun resolver all agree on what
counts as a pronoun, a subordinator, or a coordinator.
"""
from __future__ import annotations

from lokidoki.orchestrator.linguistics.english import (
    CONNECTORS,
    DETERMINERS,
    FAMILY_RELATIONS,
    FINITE_AUX,
    INTERJECTIONS,
    NUMBER_WORDS,
    PRONOUNS,
    SUBORDINATORS,
    WH_WORDS,
    WORD_OPERATORS,
)

__all__ = [
    "CONNECTORS",
    "DETERMINERS",
    "FAMILY_RELATIONS",
    "FINITE_AUX",
    "INTERJECTIONS",
    "NUMBER_WORDS",
    "PRONOUNS",
    "SUBORDINATORS",
    "WH_WORDS",
    "WORD_OPERATORS",
]
