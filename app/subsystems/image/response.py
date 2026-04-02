"""Response cleanup helpers for image-analysis providers."""

from __future__ import annotations

import re


CONTROL_TOKEN_PATTERN = re.compile(r"<\|[^>]+\|>")


def clean_image_reply(reply: str) -> str:
    """Strip provider control tokens and normalize whitespace."""
    cleaned = CONTROL_TOKEN_PATTERN.sub("", reply).strip()
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()
