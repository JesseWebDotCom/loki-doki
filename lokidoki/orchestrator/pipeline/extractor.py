"""Per-chunk extraction for the pipeline.

Pulls structure from the **already-parsed** spaCy ``Doc`` rather than
running keyword regexes against the raw text. The single shared doc is
sliced into per-chunk spans so each :class:`ChunkExtraction` only sees
the tokens that belong to it.
"""
from __future__ import annotations

from typing import Any, Iterable

from lokidoki.orchestrator.core.types import ChunkExtraction, ParsedInput, RequestChunk
from lokidoki.orchestrator.linguistics import DETERMINERS, PRONOUNS


def extract_chunk_data(
    chunks: list[RequestChunk],
    parsed: ParsedInput | None = None,
) -> list[ChunkExtraction]:
    """Extract references / predicates / subject candidates per chunk."""
    out: list[ChunkExtraction] = []
    doc = parsed.doc if parsed is not None else None
    for chunk in chunks:
        if doc is not None:
            extraction = _extract_from_doc(chunk, doc)
        else:
            extraction = _extract_from_text(chunk)
        out.append(extraction)
    return out


def _extract_from_doc(chunk: RequestChunk, doc: Any) -> ChunkExtraction:
    span = _slice_span(chunk, doc)
    references: list[str] = []
    predicates: list[str] = []
    subject_candidates: list[str] = []
    entities: list[tuple[str, str]] = []

    if span is None:
        return ChunkExtraction(chunk_index=chunk.index)

    # Pronoun references come from spaCy POS tagging (PRON), filtered against
    # the closed pronoun set in linguistics.english.
    for token in span:
        if token.pos_ == "PRON" and token.lower_ in PRONOUNS:
            references.append(token.lower_)

    # Subjects = noun chunks belonging to this span. Definite noun phrases
    # (those starting with a determiner like "the" / "that" / "this") are also
    # added as references — that gives the resolver the same hook the old
    # literal DEFINITE_REFERENTS list provided, but derived structurally from
    # the spaCy parse instead of from a curated phrase list.
    for noun_chunk in doc.noun_chunks:
        if noun_chunk.start < span.start or noun_chunk.end > span.end:
            continue
        subject_candidates.append(noun_chunk.text)
        if noun_chunk[0].lower_ in DETERMINERS:
            references.append(noun_chunk.text.lower())

    # Predicates = root verbs / aux + their lemma.
    for token in span:
        if token.pos_ in ("VERB", "AUX") and token.dep_ in ("ROOT", "ccomp", "xcomp", "advcl", "conj"):
            predicates.append(token.lemma_.lower())

    # Entities scoped to this span.
    for ent in doc.ents:
        if ent.start >= span.start and ent.end <= span.end:
            entities.append((ent.text, ent.label_))

    return ChunkExtraction(
        chunk_index=chunk.index,
        references=_dedup(references),
        predicates=_dedup(predicates),
        subject_candidates=_dedup(subject_candidates),
        entities=entities,
    )


def _slice_span(chunk: RequestChunk, doc: Any) -> Any | None:
    """Map a chunk's character span to a spaCy ``Span``."""
    if chunk.span_end > chunk.span_start:
        span = doc.char_span(chunk.span_start, chunk.span_end, alignment_mode="expand")
        if span is not None:
            return span
    # Fallback: locate the chunk text in the doc.
    start = doc.text.find(chunk.text)
    if start < 0:
        return doc[:]
    span = doc.char_span(start, start + len(chunk.text), alignment_mode="expand")
    return span if span is not None else doc[:]


def _extract_from_text(chunk: RequestChunk) -> ChunkExtraction:
    """Plain-text fallback used when spaCy is unavailable."""
    lower = chunk.text.lower().strip()
    references: list[str] = []
    subject_candidates: list[str] = []
    predicates: list[str] = []

    tokens = lower.split()
    for word in tokens:
        if word in PRONOUNS:
            references.append(word)
    # Naive bigram scan for "<determiner> <noun>" without a real parse.
    for index, word in enumerate(tokens[:-1]):
        if word in DETERMINERS:
            phrase = " ".join(tokens[index : index + 2])
            references.append(phrase)
    if lower:
        subject_candidates.append(lower)
    return ChunkExtraction(
        chunk_index=chunk.index,
        references=_dedup(references),
        predicates=predicates,
        subject_candidates=subject_candidates,
    )


def _dedup(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
