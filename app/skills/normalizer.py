"""Text normalization and stemming for skill routing."""

from __future__ import annotations

import re

# Simple Porter-lite stemming rules
STEM_RULES = [
    (r"ies$", "y"),
    (r"es$", ""),
    (r"s$", ""),
    (r"ing$", ""),
    (r"ed$", ""),
]


def tokenize(text: str) -> list[str]:
    """Tokenize and lowercase text, stripping punctuation."""
    # Split on non-alphanumeric and underscores, keeping only meaningful tokens
    tokens = re.findall(r"[a-z0-9_']+", text.lower())
    return [t for t in tokens if t]


def normalize_tokens(tokens: list[str]) -> list[str]:
    """Apply stemming and normalization to a list of tokens."""
    return [stem_word(t) for t in tokens]


def stem_word(word: str) -> str:
    """Return a simplified stem for one word."""
    if len(word) <= 3:
        return word
    
    stemmed = word
    for pattern, replacement in STEM_RULES:
        new_stem = re.sub(pattern, replacement, word)
        if new_stem != word and len(new_stem) >= 3:
            stemmed = new_stem
            break
            
    return stemmed


class Normalizer:
    """Consolidated text normalization for skill routing."""

    def normalize(self, text: str) -> list[str]:
        """Return a list of normalized and stemmed tokens for the input text."""
        return normalize_tokens(tokenize(text))

    def normalize_manifest_text(self, text: str) -> list[str]:
        """Normalize descriptive text from a manifest (potentially across multiple sentences)."""
        return self.normalize(text)
