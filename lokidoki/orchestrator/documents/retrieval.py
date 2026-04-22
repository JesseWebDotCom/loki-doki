"""Retrieval path — chunk the document and surface the top-K matches.

Design choices (locked to chunk 17's constraints):

* **Sentence-aware chunking** at ~400 tokens with 50-token overlap so
  a fact that spans two paragraphs survives the split.
* **Local-only BM25** scoring — no embeddings, no network, no ANN.
  The repo's existing vector infra (``lokidoki/orchestrator/memory``)
  is scoped to tier-specific memory slots, not ad-hoc document
  corpora. Wiring in a second backing store was deferred explicitly
  by chunk 17; BM25 is the right footprint for Pi CPU and keeps the
  implementation in pure Python.
* **K per profile** — 5 on ``pi_cpu``; 8 on ``mac`` / ``pi_hailo``.

Every path must work with the network unplugged; the only I/O is
reading the attached file from disk.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from lokidoki.orchestrator.adapters.base import Source
from lokidoki.orchestrator.documents.extraction import extract_pages
from lokidoki.orchestrator.documents.strategy import DocumentMeta


# Roughly 4 chars / token matches the coarse estimator in
# :func:`extraction.estimate_tokens`; good enough for chunk sizing.
_CHARS_PER_TOKEN = 4
_CHUNK_TOKENS = 400
_OVERLAP_TOKENS = 50
_SNIPPET_CHARS = 200

K_BY_PROFILE: dict[str, int] = {
    "mac": 8,
    "windows": 8,
    "linux": 8,
    "pi_hailo": 8,
    "pi_cpu": 5,
}

_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
_TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


@dataclass(frozen=True, slots=True)
class DocumentChunk:
    """One retrievable slice of a document."""

    text: str
    page: int
    chunk_index: int


def top_k_for(profile: str | None) -> int:
    """Return the K retrieval budget for ``profile`` (defaults to Pi CPU)."""
    if not profile:
        return K_BY_PROFILE["pi_cpu"]
    return K_BY_PROFILE.get(profile, K_BY_PROFILE["pi_cpu"])


def chunk_document(doc_meta: DocumentMeta) -> list[DocumentChunk]:
    """Return sentence-aware chunks with a rolling overlap.

    Pages come from :func:`extraction.extract_pages`; each chunk
    records the originating 1-based page number so the source card
    can cite it. Non-PDF kinds surface as page ``1``.
    """
    pages = extract_pages(doc_meta.path, doc_meta.kind)
    chunks: list[DocumentChunk] = []
    global_idx = 0
    for page_index, page_text in enumerate(pages, start=1):
        if not page_text.strip():
            continue
        for chunk_text in _split_page(page_text):
            if not chunk_text.strip():
                continue
            chunks.append(
                DocumentChunk(
                    text=chunk_text,
                    page=page_index,
                    chunk_index=global_idx,
                )
            )
            global_idx += 1
    return chunks


def _split_page(text: str) -> list[str]:
    """Split one page into ~400-token chunks with 50-token overlap."""
    sentences = [s.strip() for s in _SENTENCE_BOUNDARY.split(text) if s.strip()]
    if not sentences:
        return []
    target_chars = _CHUNK_TOKENS * _CHARS_PER_TOKEN
    overlap_chars = _OVERLAP_TOKENS * _CHARS_PER_TOKEN

    chunks: list[str] = []
    buffer: list[str] = []
    buffer_len = 0
    for sentence in sentences:
        if buffer_len + len(sentence) + 1 > target_chars and buffer:
            chunks.append(" ".join(buffer).strip())
            carry = _overlap_tail(buffer, overlap_chars)
            buffer = carry
            buffer_len = sum(len(s) + 1 for s in buffer)
        buffer.append(sentence)
        buffer_len += len(sentence) + 1
    if buffer:
        chunks.append(" ".join(buffer).strip())
    return chunks


def _overlap_tail(buffer: list[str], overlap_chars: int) -> list[str]:
    """Pick the trailing sentences whose combined length covers the overlap."""
    if overlap_chars <= 0:
        return []
    tail: list[str] = []
    acc = 0
    for sentence in reversed(buffer):
        tail.insert(0, sentence)
        acc += len(sentence) + 1
        if acc >= overlap_chars:
            break
    return tail


def _tokenize(text: str) -> list[str]:
    return [tok.lower() for tok in _TOKEN_RE.findall(text)]


def _bm25_scores(
    chunks: list[DocumentChunk],
    query_tokens: list[str],
    *,
    k1: float = 1.5,
    b: float = 0.75,
) -> list[float]:
    """Classic BM25 — the math is standard; the implementation is small on purpose."""
    if not chunks or not query_tokens:
        return [0.0] * len(chunks)

    tokenized = [_tokenize(chunk.text) for chunk in chunks]
    doc_lengths = [len(tokens) for tokens in tokenized]
    avg_doc_len = sum(doc_lengths) / len(doc_lengths) if doc_lengths else 0.0

    doc_frequencies: Counter[str] = Counter()
    for tokens in tokenized:
        for term in set(tokens):
            doc_frequencies[term] += 1
    n_docs = len(chunks)

    scores: list[float] = []
    for tokens, doc_len in zip(tokenized, doc_lengths):
        tf = Counter(tokens)
        score = 0.0
        for term in query_tokens:
            if term not in tf:
                continue
            df = doc_frequencies.get(term, 0)
            if df == 0:
                continue
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            freq = tf[term]
            denom = freq + k1 * (1 - b + b * (doc_len / avg_doc_len if avg_doc_len else 1))
            score += idf * freq * (k1 + 1) / denom if denom else 0.0
        scores.append(score)
    return scores


def retrieve(
    doc_meta: DocumentMeta,
    query: str,
    *,
    profile: str | None,
) -> list[Source]:
    """Return up to ``top_k_for(profile)`` sources scored by BM25.

    Chunks are ranked once per turn — no persistent index, no warm
    cache. The cost is ``O(chunks * query_terms)`` which is trivial
    for the documents users actually attach (hundreds of pages at
    most).
    """
    chunks = chunk_document(doc_meta)
    if not chunks:
        return []
    query_tokens = _tokenize(query or "")
    if not query_tokens:
        # No query terms — fall back to document order so the caller
        # still receives provenance. Useful when the retrieval path
        # fires on a generic "summarize this" turn.
        ranked = chunks[: top_k_for(profile)]
    else:
        scores = _bm25_scores(chunks, query_tokens)
        # Pair with index so stable tie-breaking falls back to order.
        scored = sorted(
            zip(chunks, scores),
            key=lambda item: (-item[1], item[0].chunk_index),
        )
        ranked_nonzero = [chunk for chunk, score in scored if score > 0]
        ranked = ranked_nonzero[: top_k_for(profile)]
        if not ranked:
            ranked = chunks[: top_k_for(profile)]

    path = Path(doc_meta.path)
    base_title = path.name or "document"
    url = path.as_uri() if path.is_absolute() else f"file://{path.as_posix()}"
    sources: list[Source] = []
    for chunk in ranked:
        snippet = chunk.text[:_SNIPPET_CHARS].strip()
        sources.append(
            Source(
                title=f"{base_title} (p. {chunk.page})",
                url=url,
                kind="doc",
                snippet=snippet or None,
                page=chunk.page,
            )
        )
    return sources


__all__ = [
    "DocumentChunk",
    "K_BY_PROFILE",
    "chunk_document",
    "retrieve",
    "top_k_for",
]
