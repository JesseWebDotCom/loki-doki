"""spaCy-backed parser for the pipeline.

The spec is explicit: parse exactly **once** per utterance and reuse the
resulting ``Doc`` everywhere downstream. The model is loaded lazily and
cached for the process lifetime; if spaCy or the English model is missing
we degrade to a regex tokenizer so unit tests do not need the heavy model.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from lokidoki.orchestrator.core.types import ParsedInput

TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


@lru_cache(maxsize=1)
def _load_spacy() -> Any | None:
    """Load ``en_core_web_sm`` once. Return None if unavailable."""
    try:
        import spacy  # type: ignore
    except ImportError:
        return None
    try:
        return spacy.load("en_core_web_sm")
    except Exception:
        return None


def parse_text(cleaned_text: str) -> ParsedInput:
    """Run spaCy a single time and capture token/entity/noun-chunk views."""
    nlp = _load_spacy()
    if nlp is None:
        return _fallback_parse(cleaned_text)

    doc = nlp(cleaned_text)
    tokens = [token.text for token in doc if not token.is_space]
    sentences = [sent.text.strip() for sent in doc.sents if sent.text.strip()]
    entities = [(ent.text, ent.label_) for ent in doc.ents]
    noun_chunks = [chunk.text for chunk in doc.noun_chunks]
    return ParsedInput(
        token_count=len(tokens),
        tokens=tokens,
        sentences=sentences or ([cleaned_text] if cleaned_text else []),
        parser="spacy:en_core_web_sm",
        doc=doc,
        entities=entities,
        noun_chunks=noun_chunks,
    )


def _fallback_parse(cleaned_text: str) -> ParsedInput:
    tokens = TOKEN_RE.findall(cleaned_text)
    sentences = [cleaned_text.strip()] if cleaned_text.strip() else []
    return ParsedInput(
        token_count=len(tokens),
        tokens=tokens,
        sentences=sentences,
        parser="regex-fallback",
        doc=None,
        entities=[],
        noun_chunks=[],
    )
