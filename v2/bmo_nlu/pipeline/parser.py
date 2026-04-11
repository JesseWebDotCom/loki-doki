"""Simple parser stage for the v2 prototype."""
from __future__ import annotations

import re

from v2.bmo_nlu.core.types import ParsedInput


TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


def parse_text(cleaned_text: str) -> ParsedInput:
    """Build a lightweight parsed representation without external dependencies."""
    tokens = TOKEN_RE.findall(cleaned_text)
    sentences = [cleaned_text.strip()] if cleaned_text.strip() else []
    return ParsedInput(
        token_count=len(tokens),
        tokens=tokens,
        sentences=sentences,
    )
