"""Shared helpers for the memory store modules."""
from __future__ import annotations

from datetime import datetime


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _humanize_predicate(predicate: str) -> str:
    """Convert ``lives_in`` -> ``lives in`` for embedding text."""
    return predicate.replace("_", " ")
