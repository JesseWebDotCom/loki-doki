"""Clause splitting heuristics for the v2 prototype."""
from __future__ import annotations

from v2.bmo_nlu.core.types import RequestChunk


def split_requests(cleaned_text: str) -> list[RequestChunk]:
    """Split obvious compound requests joined by 'and'."""
    parts = [part.strip() for part in cleaned_text.split(" and ") if part.strip()]
    if len(parts) <= 1:
        return [RequestChunk(text=cleaned_text, index=0)]
    return [RequestChunk(text=part, index=index) for index, part in enumerate(parts)]
