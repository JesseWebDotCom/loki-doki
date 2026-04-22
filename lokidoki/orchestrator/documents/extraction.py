"""Local-only text extraction for attached documents.

Rules (per CLAUDE.md + chunk 17's offline invariant):

* Every path is strictly offline — no remote extraction / OCR service.
* Plain text / markdown read straight off disk.
* PDF extraction uses ``pypdf`` when bootstrap installed it; if
  ``pypdf`` is missing the extractor returns an empty string and the
  caller degrades to "no extractable text" instead of crashing.
* DOCX extraction is out of scope for chunk 17 (the design doc lists
  it but no DOCX path exists in the pipeline yet) — the extractor
  returns an empty string so the strategy still chooses a path.

The module never raises — every recoverable error becomes an empty
string so one bad attachment can't break the turn.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("lokidoki.orchestrator.documents.extraction")


def estimate_tokens(text: str) -> int:
    """Cheap 4-chars-per-token proxy used by the strategy gate."""
    return max(1, len(text) // 4) if text else 0


def extract_text(path: str | Path, kind: str) -> str:
    """Return plain text extracted from ``path`` given its ``kind``.

    Never raises — returns ``""`` when extraction is impossible.
    Unsupported kinds are logged once at debug level so surprising
    misroutes are visible without flooding telemetry.
    """
    p = Path(path)
    if not p.exists() or not p.is_file():
        return ""

    lowered = (kind or "").lower().lstrip(".")
    try:
        if lowered in ("txt", "md", "markdown"):
            return p.read_text(encoding="utf-8", errors="replace")
        if lowered == "pdf":
            return _extract_pdf_text(p)
        # Unknown / DOCX: treat as plain text if decoding works;
        # otherwise return empty so the strategy picks inline with a
        # zero-token doc and downstream shows an empty source.
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
    except OSError:
        logger.debug("extract_text failed to open %s", p, exc_info=True)
        return ""


def _extract_pdf_text(path: Path) -> str:
    """Extract raw text from a PDF using ``pypdf`` if available.

    Falls back to an empty string when ``pypdf`` is not installed
    (bootstrap hasn't landed yet) — the caller then treats the
    document as having zero extractable tokens.
    """
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        logger.debug("pypdf is not installed; skipping PDF text extraction")
        return ""

    try:
        reader = PdfReader(str(path))
    except Exception:  # noqa: BLE001 — malformed PDFs must not break the turn
        logger.debug("pypdf failed to open %s", path, exc_info=True)
        return ""

    pieces: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 — per-page failure shouldn't kill the doc
            text = ""
        if text:
            pieces.append(text)
    return "\n\n".join(pieces)


def extract_pages(path: str | Path, kind: str) -> list[str]:
    """Return a list of per-page strings. Non-PDF kinds collapse to one page.

    Used by the retrieval path so each chunk can carry a ``page``
    number on its ``Source``. Empty pages are kept as placeholders so
    callers can preserve page indexing.
    """
    p = Path(path)
    lowered = (kind or "").lower().lstrip(".")
    if lowered != "pdf":
        text = extract_text(p, kind)
        return [text] if text else []
    if not p.exists():
        return []

    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        logger.debug("pypdf is not installed; retrieval will see zero pages")
        return []

    try:
        reader = PdfReader(str(p))
    except Exception:  # noqa: BLE001
        return []

    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            pages.append("")
    return pages


__all__ = ["estimate_tokens", "extract_pages", "extract_text"]
