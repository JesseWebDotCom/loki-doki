"""Clause segmentation for the pipeline.

Splitting is **not** a string operation: ``and`` joins coordinated
attributes ("scary and gory") far more often than it joins distinct
requests ("rated R and what time is it"). When a spaCy ``Doc`` is
available we use POS / dependency information to make that distinction
and to peel off subordinate clauses ("...because I'm late") as
``supporting_context``. When the doc is unavailable we fall back to a
conservative split heuristic.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.core.types import ParsedInput, RequestChunk
from lokidoki.orchestrator.linguistics import (
    FINITE_AUX,
    INTERJECTIONS,
    SUBORDINATORS,
    WH_WORDS,
)


def split_requests(parsed: ParsedInput | str) -> list[RequestChunk]:
    """Return ordered request chunks for an utterance.

    Accepts either a :class:`ParsedInput` (preferred) or a raw string for
    backward compatibility with callers that have not been migrated yet.
    """
    if isinstance(parsed, str):
        return _string_only_split(parsed)

    if parsed.doc is None:
        return _string_only_split(" ".join(parsed.sentences) if parsed.sentences else "")

    return _doc_split(parsed.doc)


def _doc_split(doc: Any) -> list[RequestChunk]:
    text = doc.text
    if not text.strip():
        return []

    # 0. Split on sentence boundaries when spaCy finds multiple sentences
    #    and each looks like an independent speech act. Handles multi-part
    #    inputs like "what? he was on the sopranos? as what?"
    sents = list(doc.sents)
    if len(sents) >= 2:
        sent_texts = [s.text.strip() for s in sents if s.text.strip()]
        if len(sent_texts) >= 2 and _independent_requests(sent_texts):
            return [
                RequestChunk(text=st, index=i, role="primary_request")
                for i, st in enumerate(sent_texts)
            ]

    # 1. Peel off subordinate clauses (because/if/since/...).
    primary_text, supporting_text = _split_subordinate(doc)

    # 2. Within the primary text, decide whether to split on coordinator.
    primary_chunks = _coordinator_split(primary_text)

    chunks = _build_chunks(text, primary_chunks, supporting_text)
    return chunks or [RequestChunk(text=text, index=0)]


def _build_chunks(
    text: str,
    primary_chunks: list[str],
    supporting_text: str,
) -> list[RequestChunk]:
    """Assemble RequestChunk objects from split text segments."""
    chunks: list[RequestChunk] = []
    cursor = 0
    for index, chunk_text in enumerate(primary_chunks):
        start = text.find(chunk_text, cursor)
        if start < 0:
            start = cursor
        end = start + len(chunk_text)
        cursor = end
        chunks.append(
            RequestChunk(
                text=chunk_text,
                index=index,
                role="primary_request",
                span_start=start,
                span_end=end,
            )
        )
    if supporting_text:
        start = text.find(supporting_text)
        chunks.append(
            RequestChunk(
                text=supporting_text,
                index=len(chunks),
                role="supporting_context",
                span_start=max(start, 0),
                span_end=max(start, 0) + len(supporting_text),
            )
        )
    return chunks


def _split_subordinate(doc: Any) -> tuple[str, str]:
    """Return ``(primary_text, supporting_text)`` from a spaCy doc."""
    for token in doc:
        lower = token.lower_
        if lower not in SUBORDINATORS:
            continue
        if token.pos_ != "SCONJ" and token.dep_ != "mark":
            # Word matches a subordinator string but is not actually one
            # in this sentence (e.g. "if" used as a noun) — skip.
            continue
        sub_start = token.idx
        # Sentence-initial "when" / "while" / "if" is interrogative or
        # conditional and the WHOLE clause is the primary request — there
        # is no preceding clause to peel off. spaCy still tags it as
        # SCONJ in a question like "when is my sister's birthday", so we
        # have to disambiguate by position.
        if not doc.text[:sub_start].strip():
            return doc.text.strip(), ""
        # If the subordinator follows a coordinating conjunction
        # ("... and when ...", "... or while ..."), defer to the
        # coordinator split — the user is asking two coordinated
        # questions, not stating a main clause + subordinate clause.
        if token.i > 0 and doc[token.i - 1].lower_ in {"and", "or"}:
            continue
        primary = doc.text[:sub_start].strip().rstrip(",;:")
        supporting = doc.text[sub_start:].strip()
        return primary, supporting
    return doc.text.strip(), ""


def _coordinator_split(text: str) -> list[str]:
    """Split a primary clause on ``and`` only when both halves are independent requests."""
    if not text:
        return []

    parts = [part.strip() for part in _iter_and_segments(text) if part.strip()]
    if len(parts) <= 1:
        return [text]

    if not _independent_requests(parts):
        return [text]

    return parts


def _iter_and_segments(text: str) -> list[str]:
    lower = text.lower()
    pieces: list[str] = []
    cursor = 0
    while True:
        idx = lower.find(" and ", cursor)
        if idx < 0:
            break
        pieces.append(text[cursor:idx])
        cursor = idx + len(" and ")
    pieces.append(text[cursor:])
    return pieces


def _independent_requests(parts: list[str]) -> bool:
    """Decide whether all sibling clauses look like independent speech acts."""
    flags: list[bool] = []
    for part in parts:
        lower = part.lower().strip().rstrip("?.!,")
        if not lower:
            flags.append(False)
            continue
        if lower in INTERJECTIONS:
            flags.append(True)
            continue
        words = lower.split()
        first = words[0]
        if first in WH_WORDS:
            flags.append(True)
            continue
        # Short interrogative fragments ("as what?", "since when?",
        # "for real?") — any WH-word in a ≤3 word phrase.
        if len(words) <= 3 and any(w in WH_WORDS for w in words):
            flags.append(True)
            continue
        if _looks_like_command(lower):
            flags.append(True)
            continue
        if _has_finite_verb(lower):
            flags.append(True)
            continue
        flags.append(False)
    return all(flags)


def _has_finite_verb(lower: str) -> bool:
    """Cheap proxy for "this clause contains a real predicate"."""
    tokens = [token.strip("'\"?!.,") for token in lower.split()]
    return any(token in FINITE_AUX for token in tokens)


def _looks_like_command(lower: str) -> bool:
    command_starts = (
        "spell ",
        "tell me",
        "show me",
        "turn on",
        "turn off",
        "set ",
        "play ",
        "stop ",
        "open ",
        "close ",
        "send ",
        "text ",
        "call ",
        "remind ",
        "fix ",
        "explain ",
        "explain it",
        "write ",
        "debug ",
        "summarize ",
        "summarise ",
        "translate ",
        "convert ",
        "create ",
        "generate ",
        "rewrite ",
        "review ",
        "find ",
        "look up",
        "search ",
    )
    return lower.startswith(command_starts) or lower in {"explain it", "fix it", "debug it"}


def _string_only_split(text: str) -> list[RequestChunk]:
    """Conservative fallback used when spaCy is unavailable."""
    if not text or not text.strip():
        return []

    cleaned = text.strip()

    # Sentence-boundary split: split on "? " when it produces multiple
    # independent sentences (e.g. "what? he said that? since when?").
    sents = _split_on_sentence_boundaries(cleaned)
    if len(sents) >= 2 and _independent_requests(sents):
        return [
            RequestChunk(text=s, index=i, role="primary_request")
            for i, s in enumerate(sents)
        ]

    primary, supporting = _peel_subordinator_string(cleaned)
    parts = _coordinator_split(primary)
    chunks = [
        RequestChunk(text=part, index=index, role="primary_request")
        for index, part in enumerate(parts)
    ]
    if supporting:
        chunks.append(
            RequestChunk(text=supporting, index=len(chunks), role="supporting_context")
        )
    return chunks or [RequestChunk(text=cleaned, index=0)]


def _split_on_sentence_boundaries(text: str) -> list[str]:
    """Split text on sentence-ending punctuation (? ! .) into segments."""
    import re
    # Split after sentence-ending punctuation followed by a space or end.
    parts = re.split(r'(?<=[.?!])\s+', text)
    return [p.strip() for p in parts if p.strip()]


def _peel_subordinator_string(text: str) -> tuple[str, str]:
    lower = text.lower()
    for word in SUBORDINATORS:
        marker = f" {word} "
        idx = lower.find(marker)
        if idx < 0:
            continue
        primary = text[:idx].strip().rstrip(",;:")
        supporting = text[idx + 1 :].strip()
        return primary, supporting
    return text, ""
