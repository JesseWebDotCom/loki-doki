"""Inline document path — extract the full text and emit one source.

The inline path fires when ``choose_strategy`` returns ``"inline"``.
The full extracted text is returned alongside a single
:class:`~lokidoki.orchestrator.adapters.base.Source` describing the
document; the adapter stitches both onto ``AdapterOutput`` for the
rest of the pipeline to consume.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from lokidoki.orchestrator.adapters.base import Source
from lokidoki.orchestrator.documents.extraction import extract_text
from lokidoki.orchestrator.documents.strategy import DocumentMeta


_SNIPPET_CHARS = 140


@dataclass(frozen=True, slots=True)
class InlineDocument:
    """Full-text document plus a presentable ``Source`` entry."""

    text: str
    source: Source


def load_inline(doc_meta: DocumentMeta) -> InlineDocument:
    """Load the full document text for inline context injection.

    The returned ``source.url`` uses a ``file://`` scheme so the
    envelope's source surface can render a local link without
    reaching any remote host — this satisfies the offline invariant.
    Empty extractions still produce a source so the UI can surface
    "no extractable text" instead of silently dropping the attachment.
    """
    text = extract_text(doc_meta.path, doc_meta.kind)
    path = Path(doc_meta.path)
    title = path.name or "document"
    snippet = text[:_SNIPPET_CHARS].strip() or None
    source = Source(
        title=title,
        url=path.as_uri() if path.is_absolute() else f"file://{path.as_posix()}",
        kind="doc",
        snippet=snippet,
    )
    return InlineDocument(text=text, source=source)


__all__ = ["InlineDocument", "load_inline"]
