"""Tests for ``run_media_augmentation_phase`` after the adapter cutover.

The phase now resolves media cards in two passes:

1. Adapter-first: flatten ``execution.adapter_output.media`` across every
   successful execution, deduped by URL / video id.
2. Fallback: only when pass 1 yielded nothing, run the legacy
   :func:`augment_with_media` pipeline (and log a warning so under-
   populated adapters are visible).
"""
from __future__ import annotations

import logging

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput
from lokidoki.orchestrator.core.pipeline_phases import (
    _media_cards_from_adapters,
    run_media_augmentation_phase,
)
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    RequestChunk,
    RouteMatch,
    TraceData,
)


def _chunk(idx: int, text: str) -> RequestChunk:
    return RequestChunk(text=text, index=idx, role="primary_request")


def _route(idx: int, capability: str) -> RouteMatch:
    return RouteMatch(chunk_index=idx, capability=capability, confidence=1.0)


def _exec(idx: int, capability: str, adapter_output: AdapterOutput | None = None) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=True,
        adapter_output=adapter_output,
        raw_result={"success": True, "sources": []},
    )


class TestAdapterCardsPass:
    def test_flattens_media_from_multiple_adapters(self):
        card_one = {"kind": "youtube_video", "url": "https://example.test/v=aaa"}
        card_two = {"kind": "youtube_channel", "url": "https://example.test/@leia"}
        executions = [
            _exec(0, "get_video", AdapterOutput(media=(card_one,))),
            _exec(1, "get_youtube_channel", AdapterOutput(media=(card_two,))),
        ]

        cards = _media_cards_from_adapters(executions)

        assert cards == [card_one, card_two]

    def test_dedupes_by_url(self):
        same = {"kind": "youtube_video", "url": "https://example.test/v=dup"}
        executions = [
            _exec(0, "get_video", AdapterOutput(media=(same,))),
            _exec(1, "get_video", AdapterOutput(media=(same,))),
        ]

        cards = _media_cards_from_adapters(executions)

        assert len(cards) == 1

    def test_ignores_executions_without_adapter_output(self):
        executions = [
            _exec(0, "lookup_movie", None),
            _exec(1, "get_video", AdapterOutput()),
        ]

        cards = _media_cards_from_adapters(executions)

        assert cards == []


@pytest.mark.anyio
async def test_phase_prefers_adapter_cards_and_skips_fallback(monkeypatch, caplog):
    """Adapter-provided cards bypass the legacy augmentor entirely."""
    adapter_card = {"kind": "youtube_video", "url": "https://example.test/v=adapter"}

    async def boom(*args, **kwargs):  # pragma: no cover
        raise AssertionError("legacy augmentor must not run when adapters supply cards")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.augment_with_media",
        boom,
    )

    executions = [_exec(0, "get_video", AdapterOutput(media=(adapter_card,)))]
    with caplog.at_level(logging.WARNING, logger="lokidoki.orchestrator.core.pipeline"):
        cards = await run_media_augmentation_phase(
            TraceData(),
            [_chunk(0, "watch this")],
            [_route(0, "get_video")],
            executions,
            raw_text="watch this",
        )

    assert cards == [adapter_card]
    fallback_warnings = [rec for rec in caplog.records if "legacy fallback" in rec.message]
    assert fallback_warnings == [], "adapter-only turns must not trigger the fallback warning"


@pytest.mark.anyio
async def test_phase_falls_back_when_adapters_are_empty(monkeypatch, caplog):
    """Empty adapter media → legacy augmentor runs and a warning is logged."""
    fallback_card = {"kind": "youtube_video", "url": "https://example.test/v=fallback"}

    async def fake_augment(chunks, routes, executions, raw_text=""):
        return [fallback_card]

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.augment_with_media",
        fake_augment,
    )

    executions = [_exec(0, "lookup_movie", AdapterOutput())]
    with caplog.at_level(logging.WARNING, logger="lokidoki.orchestrator.core.pipeline"):
        cards = await run_media_augmentation_phase(
            TraceData(),
            [_chunk(0, "the best kubrick movie")],
            [_route(0, "lookup_movie")],
            executions,
            raw_text="the best kubrick movie",
        )

    assert cards == [fallback_card]
    fallback_warnings = [rec for rec in caplog.records if "legacy fallback" in rec.message]
    assert fallback_warnings, (
        "legacy fallback activation must emit a warning so under-populated "
        "adapters are visible"
    )


@pytest.mark.anyio
async def test_phase_returns_empty_when_everything_fails(monkeypatch):
    """No adapter cards + failing legacy augmentor yields an empty list (never raises)."""

    async def boom(*args, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.augment_with_media",
        boom,
    )

    executions = [_exec(0, "lookup_movie", AdapterOutput())]
    cards = await run_media_augmentation_phase(
        TraceData(),
        [_chunk(0, "a movie")],
        [_route(0, "lookup_movie")],
        executions,
        raw_text="a movie",
    )

    assert cards == []
