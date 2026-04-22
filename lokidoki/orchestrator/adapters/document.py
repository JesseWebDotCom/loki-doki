"""Response adapter for attached-document turns.

Unlike the skill adapters, :class:`DocumentAdapter` is not driven by
the capability router — it wraps the output of
:mod:`lokidoki.orchestrator.documents.strategy` / ``inline`` /
``retrieval`` and emits an ``AdapterOutput`` that the rest of the
pipeline consumes exactly like any other source-bearing skill.

The adapter expects the pipeline to hand it a ``MechanismResult``
whose ``data`` contains::

    {
        "path": str,
        "kind": "pdf" | "txt" | "md" | "docx",
        "size_bytes": int,
        "estimated_tokens": int,
        "query": str,            # distilled query for BM25 ranking
        "profile": str | None,   # active platform profile
    }

The adapter picks the inline or retrieval branch on the fly and
returns the resulting ``AdapterOutput`` plus a ``document_mode`` hint
embedded on ``AdapterOutput.raw`` so the envelope builder can stamp
``envelope.document_mode``.
"""
from __future__ import annotations

from typing import Any

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput
from lokidoki.orchestrator.documents.inline import load_inline
from lokidoki.orchestrator.documents.retrieval import retrieve
from lokidoki.orchestrator.documents.strategy import DocumentMeta, choose_strategy


class DocumentAdapter:
    """Adapter that emits sources for an attached document."""

    skill_id = "document"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        """Translate a document mechanism payload into an ``AdapterOutput``."""
        data = result.data or {}
        meta = _doc_meta_from_payload(data)
        if meta is None:
            return AdapterOutput(raw=dict(data))

        profile = str(data.get("profile") or "") or None
        verdict = choose_strategy(meta, profile)

        if verdict == "inline":
            loaded = load_inline(meta)
            summary_candidate = (
                f"Document `{meta.path}` is in-context for this turn."
            )
            return AdapterOutput(
                summary_candidates=(summary_candidate,),
                sources=(loaded.source,),
                raw={
                    "document_mode": "inline",
                    "document_kind": meta.kind,
                    "document_text": loaded.text,
                },
            )

        query = str(data.get("query") or "")
        sources = tuple(retrieve(meta, query, profile=profile))
        summary_candidate = (
            f"Searched `{meta.path}` for relevant passages."
        )
        return AdapterOutput(
            summary_candidates=(summary_candidate,) if sources else (),
            sources=sources,
            raw={
                "document_mode": "retrieval",
                "document_kind": meta.kind,
            },
        )


def _doc_meta_from_payload(data: dict[str, Any]) -> DocumentMeta | None:
    """Build a :class:`DocumentMeta` from an adapter payload.

    Returns ``None`` when required fields are missing — callers then
    degrade to a sourceless ``AdapterOutput`` instead of crashing.
    """
    path = str(data.get("path") or "").strip()
    kind = str(data.get("kind") or "").strip().lower().lstrip(".")
    if not path or kind not in ("pdf", "txt", "md", "docx"):
        return None
    try:
        size_bytes = int(data.get("size_bytes") or 0)
    except (TypeError, ValueError):
        size_bytes = 0
    try:
        estimated_tokens = int(data.get("estimated_tokens") or 0)
    except (TypeError, ValueError):
        estimated_tokens = 0
    return DocumentMeta(
        path=path,
        size_bytes=size_bytes,
        estimated_tokens=estimated_tokens,
        kind=kind,  # type: ignore[arg-type]
    )


__all__ = ["DocumentAdapter"]
