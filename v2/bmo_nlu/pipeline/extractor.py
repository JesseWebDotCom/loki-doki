"""Chunk extraction for the v2 prototype."""
from __future__ import annotations

from v2.bmo_nlu.core.types import ChunkExtraction, RequestChunk


def extract_chunk_data(chunks: list[RequestChunk]) -> list[ChunkExtraction]:
    """Extract simple references, predicates, and subject candidates per chunk."""
    out: list[ChunkExtraction] = []
    for chunk in chunks:
        lower = chunk.text.lower().strip()
        references: list[str] = []
        predicates: list[str] = []
        subject_candidates: list[str] = []

        if "time" in lower:
            references.append("time")
            predicates.append("get")
            subject_candidates.append("time")
        if lower.startswith("how do you spell "):
            spelled = chunk.text[len("how do you spell "):].strip()
            if spelled:
                references.append(spelled.lower())
                predicates.append("spell")
                subject_candidates.append(spelled)
        elif lower.startswith("spell "):
            spelled = chunk.text[len("spell "):].strip()
            if spelled:
                references.append(spelled.lower())
                predicates.append("spell")
                subject_candidates.append(spelled)
        if lower in {"hello", "hi", "hey", "hello there", "hi there"}:
            predicates.append("greet")
            subject_candidates.append("greeting")

        out.append(
            ChunkExtraction(
                chunk_index=chunk.index,
                references=references,
                predicates=predicates,
                subject_candidates=subject_candidates,
            )
        )
    return out
