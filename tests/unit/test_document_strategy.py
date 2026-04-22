"""Tests for the adaptive document handling stack (chunk 17).

Covers:
    * :mod:`lokidoki.orchestrator.documents.strategy` — inline vs
      retrieval gate.
    * :mod:`lokidoki.orchestrator.documents.inline` — full-text
      extraction for small docs.
    * :mod:`lokidoki.orchestrator.documents.retrieval` — sentence-aware
      BM25 retrieval over larger docs.
    * :class:`DocumentAdapter` — end-to-end translation from mechanism
      payload to ``AdapterOutput`` with ``document_mode`` hinting.
    * Envelope ``document_mode`` round-trip via serde.
    * Pipeline wiring: ``_apply_attached_document`` stamps
      ``safe_context["document_mode"]`` and appends a synthetic
      execution.

Pop-culture placeholders (Luke, Yoda, Padme, Obi-Wan) per CLAUDE.md.
"""
from __future__ import annotations

import os

import pytest

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.document import DocumentAdapter
from lokidoki.orchestrator.core.pipeline_phases import _apply_attached_document
from lokidoki.orchestrator.core.types import ExecutionResult, RequestSpec
from lokidoki.orchestrator.documents import (
    DEFAULT_CONTEXT_TOKENS,
    DocumentMeta,
    choose_strategy,
    context_tokens_for,
)
from lokidoki.orchestrator.documents.inline import load_inline
from lokidoki.orchestrator.documents.retrieval import (
    K_BY_PROFILE,
    chunk_document,
    retrieve,
    top_k_for,
)
from lokidoki.orchestrator.response import ResponseEnvelope
from lokidoki.orchestrator.response.serde import envelope_from_dict, envelope_to_dict


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def small_markdown(tmp_path):
    """3 KB markdown file — well under any context window."""
    path = tmp_path / "luke-profile.md"
    path.write_text(
        "# Luke Skywalker\n\n"
        "Luke trained with Yoda on Dagobah. "
        "He later rebuilt the Jedi Order after the fall of the Empire. "
        "Padme Amidala, his mother, served as a senator of Naboo.\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def big_text(tmp_path):
    """Large text file far bigger than the Pi CPU context budget."""
    path = tmp_path / "padme-archive.txt"
    sentences = [
        "Padme Amidala was queen of Naboo before joining the senate.",
        "Obi-Wan Kenobi trained Anakin Skywalker in the ways of the Force.",
        "Yoda retreated to Dagobah after the fall of the Republic.",
        "Luke Skywalker discovered his lineage on Bespin.",
    ]
    # ~4 KB per iteration × 1500 = ~6 MB, well into retrieval land even
    # with the generous Mac context window.
    lines = []
    for _ in range(1500):
        lines.extend(sentences)
    path.write_text(" ".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Strategy gate
# ---------------------------------------------------------------------------


class TestChooseStrategy:
    """The inline-vs-retrieval decision is a pure function of token count."""

    def test_small_markdown_is_inline_on_pi_cpu(self):
        meta = DocumentMeta(
            path="/tmp/small.md",
            size_bytes=3 * 1024,
            estimated_tokens=700,
            kind="md",
        )
        assert choose_strategy(meta, "pi_cpu") == "inline"

    def test_large_document_flips_to_retrieval(self):
        # 10 MB-ish rough size, 2 500 000 tokens — way past every profile.
        meta = DocumentMeta(
            path="/tmp/large.pdf",
            size_bytes=10 * 1024 * 1024,
            estimated_tokens=2_500_000,
            kind="pdf",
        )
        assert choose_strategy(meta, "pi_cpu") == "retrieval"
        assert choose_strategy(meta, "mac") == "retrieval"

    def test_boundary_uses_half_of_context_tokens(self):
        ctx = DEFAULT_CONTEXT_TOKENS["mac"]
        # Just under half → inline.
        meta_inline = DocumentMeta(
            path="x", size_bytes=0, estimated_tokens=(ctx // 2) - 10, kind="txt"
        )
        assert choose_strategy(meta_inline, "mac") == "inline"
        # Exactly half → retrieval (strict less-than gate).
        meta_retrieval = DocumentMeta(
            path="x", size_bytes=0, estimated_tokens=ctx // 2, kind="txt"
        )
        assert choose_strategy(meta_retrieval, "mac") == "retrieval"

    def test_unknown_profile_falls_back_to_pi_cpu_ceiling(self):
        assert context_tokens_for("not-a-profile") == DEFAULT_CONTEXT_TOKENS["pi_cpu"]

    def test_zero_token_document_is_inline(self):
        meta = DocumentMeta(
            path="/tmp/empty.txt",
            size_bytes=0,
            estimated_tokens=0,
            kind="txt",
        )
        # Empty file — nothing to retrieve; inline so the UI surfaces
        # the empty-source case instead of silently dropping it.
        assert choose_strategy(meta, "pi_cpu") == "inline"


# ---------------------------------------------------------------------------
# Inline path
# ---------------------------------------------------------------------------


class TestLoadInline:
    def test_returns_full_text_and_file_source(self, small_markdown):
        meta = DocumentMeta(
            path=str(small_markdown),
            size_bytes=small_markdown.stat().st_size,
            estimated_tokens=200,
            kind="md",
        )
        loaded = load_inline(meta)
        assert "Luke trained with Yoda" in loaded.text
        assert loaded.source.kind == "doc"
        assert loaded.source.url is not None
        assert loaded.source.url.startswith("file://")
        assert loaded.source.title == small_markdown.name
        assert loaded.source.snippet
        assert "Luke Skywalker" in loaded.source.snippet


# ---------------------------------------------------------------------------
# Retrieval path
# ---------------------------------------------------------------------------


class TestRetrievalBM25:
    def test_chunks_document_preserves_page_indexing(self, big_text):
        meta = DocumentMeta(
            path=str(big_text),
            size_bytes=big_text.stat().st_size,
            estimated_tokens=1_000_000,
            kind="txt",
        )
        chunks = chunk_document(meta)
        assert chunks, "chunking should produce at least one chunk"
        # Non-PDF documents collapse to page 1 per the extractor contract.
        assert {c.page for c in chunks} == {1}

    def test_top_k_per_profile(self):
        assert top_k_for("pi_cpu") == 5
        assert top_k_for("mac") == 8
        assert top_k_for("pi_hailo") == 8
        assert K_BY_PROFILE["pi_cpu"] == 5

    def test_retrieve_returns_bounded_sources_with_snippet_and_page(self, big_text):
        meta = DocumentMeta(
            path=str(big_text),
            size_bytes=big_text.stat().st_size,
            estimated_tokens=1_000_000,
            kind="txt",
        )
        sources = retrieve(meta, "padme naboo senator", profile="pi_cpu")
        assert 0 < len(sources) <= 5
        for src in sources:
            assert src.kind == "doc"
            assert src.snippet is not None and src.snippet
            assert src.page == 1
            assert src.url and src.url.startswith("file://")

    def test_retrieve_offline_does_not_reach_network(
        self, big_text, monkeypatch
    ):
        """Runs with HTTP clients sabotaged — retrieval must stay local."""
        # If retrieval ever tries to open a socket, httpx.Client() would
        # fire; we assert no imports happen by monkeypatching
        # ``socket.socket`` to raise.
        import socket

        real_socket = socket.socket

        def _no_network(*args, **kwargs):  # pragma: no cover - guard
            raise RuntimeError("offline invariant violated")

        monkeypatch.setattr(socket, "socket", _no_network)
        try:
            meta = DocumentMeta(
                path=str(big_text),
                size_bytes=big_text.stat().st_size,
                estimated_tokens=1_000_000,
                kind="txt",
            )
            sources = retrieve(meta, "luke bespin", profile="pi_cpu")
        finally:
            monkeypatch.setattr(socket, "socket", real_socket)
        assert sources, "retrieval should return local-only sources"


# ---------------------------------------------------------------------------
# DocumentAdapter
# ---------------------------------------------------------------------------


class TestDocumentAdapter:
    def test_inline_branch_produces_single_source_and_mode_hint(
        self, small_markdown
    ):
        result = DocumentAdapter().adapt(
            MechanismResult(
                success=True,
                data={
                    "path": str(small_markdown),
                    "kind": "md",
                    "size_bytes": small_markdown.stat().st_size,
                    "estimated_tokens": 200,
                    "query": "who trained Luke",
                    "profile": "pi_cpu",
                },
            )
        )
        assert result.raw is not None
        assert result.raw["document_mode"] == "inline"
        assert len(result.sources) == 1
        assert result.sources[0].kind == "doc"
        assert result.raw["document_text"].startswith("# Luke Skywalker")

    def test_retrieval_branch_returns_multiple_sources(self, big_text):
        result = DocumentAdapter().adapt(
            MechanismResult(
                success=True,
                data={
                    "path": str(big_text),
                    "kind": "txt",
                    "size_bytes": big_text.stat().st_size,
                    "estimated_tokens": 2_000_000,
                    "query": "yoda dagobah retreat",
                    "profile": "pi_cpu",
                },
            )
        )
        assert result.raw is not None
        assert result.raw["document_mode"] == "retrieval"
        assert 1 <= len(result.sources) <= 5

    def test_missing_path_degrades_without_sources(self):
        result = DocumentAdapter().adapt(
            MechanismResult(success=True, data={"kind": "pdf"})
        )
        assert result.sources == ()
        assert result.summary_candidates == ()


# ---------------------------------------------------------------------------
# Envelope serde round-trip
# ---------------------------------------------------------------------------


class TestEnvelopeDocumentMode:
    def test_round_trip_preserves_document_mode(self):
        envelope = ResponseEnvelope(
            request_id="req-doc-1",
            mode="standard",
            status="complete",
            document_mode="retrieval",
        )
        data = envelope_to_dict(envelope)
        assert data["document_mode"] == "retrieval"
        restored = envelope_from_dict(data)
        assert restored.document_mode == "retrieval"

    def test_omits_document_mode_when_none(self):
        envelope = ResponseEnvelope(
            request_id="req-doc-2",
            mode="standard",
            status="complete",
        )
        data = envelope_to_dict(envelope)
        assert "document_mode" not in data
        restored = envelope_from_dict(data)
        assert restored.document_mode is None

    def test_unknown_document_mode_coerces_to_none(self):
        data = {
            "request_id": "req-doc-3",
            "mode": "standard",
            "status": "complete",
            "document_mode": "mystery",
        }
        restored = envelope_from_dict(data)
        assert restored.document_mode is None


# ---------------------------------------------------------------------------
# Pipeline wiring
# ---------------------------------------------------------------------------


class TestApplyAttachedDocument:
    def test_noop_when_no_attachment(self):
        ctx: dict = {}
        spec = RequestSpec(trace_id="t", original_request="")
        executions: list[ExecutionResult] = []
        _apply_attached_document(ctx, spec, executions, "whatever")
        assert executions == []
        assert "document_mode" not in ctx

    def test_inline_path_stamps_context_and_appends_execution(
        self, small_markdown
    ):
        ctx: dict = {
            "attached_document": {
                "path": str(small_markdown),
                "kind": "md",
            },
            "platform_profile": "pi_cpu",
        }
        spec = RequestSpec(trace_id="t", original_request="who trained luke")
        executions: list[ExecutionResult] = []
        _apply_attached_document(ctx, spec, executions, "who trained luke")
        assert ctx["document_mode"] == "inline"
        assert len(executions) == 1
        synthetic = executions[0]
        assert synthetic.success is True
        assert synthetic.capability == "document_attachment"
        assert synthetic.adapter_output is not None
        assert synthetic.adapter_output.sources

    def test_retrieval_path_stamps_context(self, big_text):
        ctx: dict = {
            "attached_document": {
                "path": str(big_text),
                "kind": "txt",
                "estimated_tokens": 2_000_000,
                "size_bytes": big_text.stat().st_size,
            },
            "platform_profile": "pi_cpu",
        }
        spec = RequestSpec(trace_id="t", original_request="padme naboo")
        executions: list[ExecutionResult] = []
        _apply_attached_document(ctx, spec, executions, "padme naboo")
        assert ctx["document_mode"] == "retrieval"
        assert executions[0].adapter_output is not None
        assert executions[0].adapter_output.sources

    def test_invalid_kind_is_ignored(self, small_markdown):
        ctx: dict = {
            "attached_document": {
                "path": str(small_markdown),
                "kind": "exe",
            },
            "platform_profile": "pi_cpu",
        }
        spec = RequestSpec(trace_id="t", original_request="")
        executions: list[ExecutionResult] = []
        _apply_attached_document(ctx, spec, executions, "")
        assert executions == []
        assert "document_mode" not in ctx
