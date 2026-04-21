"""Chunk 9 — rich-response SSE composition event tests.

These tests verify the new ``response_*`` / ``block_*`` event family
that rides alongside the existing pipeline-phase events.

Coverage:

* Pure-function event constructors produce the expected wire shapes.
* ``run_synthesis_phase`` streams the new events in the documented
  order when a shared ``_sse_queue`` is attached to the context.
* ``block_patch`` ``seq`` is monotonically increasing per ``block_id``.
* ``response_snapshot`` data round-trips through ``envelope_from_dict``.
* Failure path: a synthesis crash emits ``block_failed`` for the
  summary block with a non-empty reason, and the terminal ``response_done``
  carries ``status="failed"`` (emitted by the SSE wrapper).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_phases import run_synthesis_phase
from lokidoki.orchestrator.core.streaming import SSEEvent, stream_pipeline_sse
from lokidoki.orchestrator.core.types import (
    RequestChunkResult,
    RequestSpec,
    TraceData,
    ExecutionResult,
)
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.response import (
    Block,
    BlockState,
    BlockType,
    ResponseEnvelope,
    envelope_from_dict,
)
from lokidoki.orchestrator.response import events as response_events


# ---------------------------------------------------------------------------
# Pure-function event constructor tests
# ---------------------------------------------------------------------------


class TestEventConstructors:
    """Each constructor emits an ``SSEEvent`` whose ``phase`` is the event name."""

    def test_response_init_carries_planned_blocks(self):
        blocks = [
            Block(id="summary", type=BlockType.summary),
            Block(id="sources", type=BlockType.sources),
        ]
        event = response_events.response_init("t-1", "standard", blocks)

        assert event.phase == "response_init"
        assert event.status == "data"
        assert event.data["request_id"] == "t-1"
        assert event.data["mode"] == "standard"
        assert event.data["blocks"] == [
            {"id": "summary", "type": "summary"},
            {"id": "sources", "type": "sources"},
        ]

    def test_block_init_marks_state_loading(self):
        block = Block(id="summary", type=BlockType.summary)
        event = response_events.block_init(block)

        assert event.phase == "block_init"
        assert event.data == {
            "block_id": "summary",
            "type": "summary",
            "state": "loading",
        }

    def test_block_patch_delta(self):
        event = response_events.block_patch("summary", 1, delta="Luke is a Jedi.")

        assert event.phase == "block_patch"
        assert event.data["block_id"] == "summary"
        assert event.data["seq"] == 1
        assert event.data["delta"] == "Luke is a Jedi."
        assert "items_delta" not in event.data

    def test_block_patch_items_delta(self):
        event = response_events.block_patch(
            "sources", 3, items_delta=[{"url": "https://example.test/luke", "title": "Luke"}],
        )

        assert event.data["seq"] == 3
        assert event.data["items_delta"] == [
            {"url": "https://example.test/luke", "title": "Luke"},
        ]
        assert "delta" not in event.data

    def test_block_ready_shape(self):
        event = response_events.block_ready("summary")
        assert event.phase == "block_ready"
        assert event.data == {"block_id": "summary"}

    def test_block_failed_requires_reason(self):
        event = response_events.block_failed("summary", "skill timeout")
        assert event.phase == "block_failed"
        assert event.data == {"block_id": "summary", "reason": "skill timeout"}

    def test_block_failed_empty_reason_is_replaced(self):
        event = response_events.block_failed("summary", "")
        assert event.data["reason"] == "unknown"

    def test_source_add_and_media_add(self):
        source = {"url": "https://example.test/luke", "title": "Luke"}
        sa = response_events.source_add(source)
        assert sa.phase == "source_add"
        assert sa.data == {"source": source}
        # Copy semantics — mutating the caller's dict must not alter the event.
        source["title"] = "mutated"
        assert sa.data["source"]["title"] == "Luke"

        media = {"kind": "video", "url": "file:///offline/luke.mp4"}
        ma = response_events.media_add(media)
        assert ma.phase == "media_add"
        assert ma.data == {"media": media}

    def test_response_snapshot_roundtrips(self):
        envelope = ResponseEnvelope(
            request_id="t-round",
            mode="standard",
            status="complete",
            blocks=[
                Block(id="summary", type=BlockType.summary, state=BlockState.ready,
                      content="Luke is a Jedi."),
            ],
        )
        event = response_events.response_snapshot(envelope)

        assert event.phase == "response_snapshot"
        raw = event.data["envelope"]
        # round-trip invariant from chunk 6
        restored = envelope_from_dict(raw)
        assert restored.request_id == "t-round"
        assert restored.mode == "standard"
        assert restored.status == "complete"
        assert restored.blocks[0].content == "Luke is a Jedi."

    def test_response_done_terminal(self):
        event = response_events.response_done("t-1", "complete")
        assert event.phase == "response_done"
        assert event.data == {"request_id": "t-1", "status": "complete"}


# ---------------------------------------------------------------------------
# Synthesis-phase integration: drain a real queue
# ---------------------------------------------------------------------------


def _exec(idx: int, capability: str, adapter_output: AdapterOutput) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=True,
        adapter_output=adapter_output,
    )


def _drain_queue(queue: asyncio.Queue) -> list[SSEEvent]:
    events: list[SSEEvent] = []
    while not queue.empty():
        item = queue.get_nowait()
        assert isinstance(item, SSEEvent)
        events.append(item)
    return events


@pytest.mark.anyio
async def test_synthesis_phase_streams_ordered_response_events(monkeypatch):
    """A calculator-shaped adapter with sources fires the full event sequence."""
    spec = RequestSpec(
        trace_id="t-9",
        original_request="2 + 2",
        chunks=[
            RequestChunkResult(
                text="2 + 2",
                role="primary_request",
                capability="calculator",
                confidence=1.0,
                success=True,
                result={"output_text": "2 + 2 = 4"},
            ),
        ],
    )
    executions = [
        _exec(
            0,
            "calculator",
            AdapterOutput(
                summary_candidates=("2 + 2 = 4",),
                facts=("Addition is commutative.",),
                sources=(
                    Source(title="Arithmetic Manual", url="file:///offline/arith.html", kind="doc"),
                ),
            ),
        ),
    ]

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    from lokidoki.orchestrator.fallbacks.llm_fallback import LLMDecision
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda s: LLMDecision(needed=False, reason="unit test"),
    )

    queue: asyncio.Queue = asyncio.Queue()
    context = {"_sse_queue": queue}

    trace = TraceData(trace_id="t-9")
    response, envelope = await run_synthesis_phase(
        trace, context, "2 + 2", spec, executions, None, get_runtime(),
    )

    assert response.output_text
    assert envelope.status == "complete"

    events = _drain_queue(queue)
    phases = [e.phase for e in events]

    # Core ordered sequence for a calculator turn with one source
    # under chunk 15's standard mode. Calculator never surfaces
    # ``follow_up_candidates`` so follow_ups is NOT allocated (chunk 15
    # no-fabrication rule). The live ``status`` block IS always
    # allocated; the synthesis phase itself emits one
    # "Pulling a summary together" patch, then the status block is
    # flipped to ``omitted`` before block_ready so it never renders.
    #
    # response_init -> block_init{summary} -> block_init{sources}
    # -> block_init{status}
    # -> block_patch{summary,seq=1} -> source_add -> block_patch{status,seq=1}
    # -> block_ready{summary} -> block_ready{sources}
    # -> response_snapshot
    assert phases == [
        "response_init",
        "block_init",
        "block_init",
        "block_init",
        "block_patch",
        "source_add",
        "block_patch",
        "block_ready",
        "block_ready",
        "response_snapshot",
    ]

    # response_init carries every planned block stub in order.
    init = events[0]
    assert init.data["request_id"] == "t-9"
    assert init.data["mode"] == "standard"
    assert [b["id"] for b in init.data["blocks"]] == [
        "summary",
        "sources",
        "status",
    ]

    # block_inits come in the same order.
    assert events[1].data["block_id"] == "summary"
    assert events[2].data["block_id"] == "sources"
    assert events[3].data["block_id"] == "status"

    # block_patch{summary,seq=1} carries the combined response prose.
    patch_event = events[4]
    assert patch_event.data["block_id"] == "summary"
    assert patch_event.data["seq"] == 1
    assert patch_event.data["delta"] == response.output_text

    # source_add mirrors the single adapter source.
    src = events[5]
    assert src.data["source"]["url"] == "file:///offline/arith.html"

    # block_patch{status,seq=1} carries the phrase emitted when the
    # synthesis phase fired ``emit_status_patch``.
    status_patch = events[6]
    assert status_patch.data["block_id"] == "status"
    assert status_patch.data["seq"] == 1
    assert status_patch.data["delta"] == "Pulling a summary together"

    # block_ready fires for every non-omitted, populated block. The
    # status block is flipped to ``omitted`` before this loop, so it
    # never reaches block_ready.
    ready_ids = [e.data["block_id"] for e in events if e.phase == "block_ready"]
    assert ready_ids == ["summary", "sources"]

    # response_snapshot is the last emitted event and round-trips.
    snapshot = events[-1]
    assert snapshot.phase == "response_snapshot"
    restored = envelope_from_dict(snapshot.data["envelope"])
    assert restored.request_id == envelope.request_id
    assert [b.id for b in restored.blocks] == [b.id for b in envelope.blocks]


@pytest.mark.anyio
async def test_block_patch_seq_is_monotonic_per_block_id(monkeypatch):
    """Across all block_patch events for a block, ``seq`` never decreases."""
    spec = RequestSpec(
        trace_id="t-seq",
        original_request="leia",
        chunks=[
            RequestChunkResult(
                text="leia",
                role="primary_request",
                capability="knowledge_query",
                confidence=0.9,
                success=True,
                result={"output_text": "Leia is a princess of Alderaan."},
            ),
        ],
    )
    executions = [
        _exec(0, "knowledge_query", AdapterOutput(
            sources=(Source(title="Leia", url="https://example.test/leia"),),
        )),
    ]

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    from lokidoki.orchestrator.fallbacks.llm_fallback import LLMDecision
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda s: LLMDecision(needed=False, reason="unit test"),
    )

    queue: asyncio.Queue = asyncio.Queue()
    await run_synthesis_phase(
        TraceData(trace_id="t-seq"), {"_sse_queue": queue},
        "leia", spec, executions, None, get_runtime(),
    )

    events = _drain_queue(queue)
    seq_by_block: dict[str, list[int]] = {}
    for e in events:
        if e.phase == "block_patch":
            bid = e.data["block_id"]
            seq_by_block.setdefault(bid, []).append(e.data["seq"])

    for bid, seqs in seq_by_block.items():
        assert seqs == sorted(seqs), f"{bid} seq not monotonic: {seqs}"
        assert all(s >= 1 for s in seqs), f"{bid} seq must be >= 1"


@pytest.mark.anyio
async def test_synthesis_failure_emits_block_failed(monkeypatch):
    """When synthesis raises, summary block is marked failed with a reason."""
    spec = RequestSpec(
        trace_id="t-fail",
        original_request="kaboom",
        chunks=[],
    )

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.run_memory_read_path",
        lambda raw_text, ctx: {},
    )
    from lokidoki.orchestrator.fallbacks.llm_fallback import LLMDecision
    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.decide_llm",
        lambda s: LLMDecision(needed=True, reason="force llm path"),
    )

    async def _boom(_spec):
        raise RuntimeError("skill timeout")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.llm_synthesize_async",
        _boom,
    )

    queue: asyncio.Queue = asyncio.Queue()
    with pytest.raises(RuntimeError):
        await run_synthesis_phase(
            TraceData(trace_id="t-fail"), {"_sse_queue": queue},
            "kaboom", spec, [], None, get_runtime(),
        )

    events = _drain_queue(queue)
    failures = [e for e in events if e.phase == "block_failed"]
    assert len(failures) == 1
    assert failures[0].data["block_id"] == "summary"
    assert failures[0].data["reason"]


# ---------------------------------------------------------------------------
# Full SSE wrapper — response_done is terminal
# ---------------------------------------------------------------------------


def _parse(raw_chunks: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for chunk in raw_chunks:
        for line in chunk.strip().split("\n"):
            if line.startswith("data: "):
                out.append(json.loads(line[len("data: ") :]))
    return out


@pytest.mark.anyio
async def test_response_done_is_terminal_event_on_success():
    """``response_done`` is the very last event streamed for a normal turn."""
    raw: list[str] = []
    async for chunk in stream_pipeline_sse("hello"):
        raw.append(chunk)
    parsed = _parse(raw)

    last = parsed[-1]
    assert last["phase"] == "response_done"
    # Synthesis:done must still precede response_done.
    synth_done_idx = max(
        i for i, e in enumerate(parsed)
        if e["phase"] == "synthesis" and e["status"] == "done"
    )
    response_done_idx = max(i for i, e in enumerate(parsed) if e["phase"] == "response_done")
    assert synth_done_idx < response_done_idx


@pytest.mark.anyio
async def test_response_done_status_failed_on_crash():
    """A pipeline crash streams response_done with status=failed."""
    with patch(
        "lokidoki.orchestrator.core.pipeline.run_pipeline_async",
        new_callable=AsyncMock,
        side_effect=RuntimeError("kaboom"),
    ):
        raw: list[str] = []
        async for chunk in stream_pipeline_sse("anything"):
            raw.append(chunk)

    parsed = _parse(raw)
    done = [e for e in parsed if e["phase"] == "response_done"]
    assert len(done) == 1
    assert done[0]["data"]["status"] == "failed"
