"""Input normalization for the v2 prototype."""
from __future__ import annotations

import re
import unicodedata

from v2.bmo_nlu.core.types import NormalizedInput


def normalize_text(raw_text: str) -> NormalizedInput:
    """Normalize whitespace and quotes while preserving meaning."""
    cleaned = unicodedata.normalize("NFKC", raw_text)
    cleaned = cleaned.replace("\u201c", '"').replace("\u201d", '"')
    cleaned = cleaned.replace("\u2018", "'").replace("\u2019", "'")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return NormalizedInput(
        raw_text=raw_text,
        cleaned_text=cleaned,
        lowered_text=cleaned.lower(),
    )
