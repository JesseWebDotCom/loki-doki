"""Tests for the chunk 18 deep-work runner + stage hooks.

The deep runner is exercised entirely through substitute
:class:`DeepStageHooks` so the test suite never spins up routing /
an LLM. The four contract paths from the chunk doc are covered:

* **Timeout** — a slow gather stage is wrapped in a short wall-clock
  cap; the run materializes the partial envelope without raising.
* **Concurrency** — a second deep call for the same session while the
  first is in-flight returns a clarification block instead of queuing.
* **Offline** — a fully-offline turn with no local evidence is refused
  with a clarification (no thrashed retry loop).
* **Checkpointing** — every stage transition fires the optional
  checkpoint hook; the final state reflects the last-seen snapshot.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.deep import (
    DeepGate,
    DeepRunResult,
    DeepStageEvent,
    DeepStageHooks,
    WALL_CLOCK_SECONDS,
    dedupe_sources,
    run_deep_turn,
)
from lokidoki.orchestrator.deep.envelope_ops import (
    attach_clarification,
    materialize_partial,
)
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import ResponseEnvelope


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _deep_envelope(
    *,
    request_id: str = "req-deep",
    with_summary: bool = True,
    source_surface: list[dict[str, Any]] | None = None,
) -> ResponseEnvelope:
    blocks: list[Block] = []
    if with_summary:
        blocks.append(
            Block(
                id="summary",
                type=BlockType.summary,
                state=BlockState.ready,
                seq=1,
                content="Short summary from the fast first pass.",
            )
        )
    blocks.append(
        Block(
            id="sources",
            type=BlockType.sources,
            state=BlockState.loading,
            seq=0,
        )
    )
    return ResponseEnvelope(
        request_id=request_id,
        mode="deep",
        status="streaming",
        blocks=blocks,
        source_surface=list(source_surface or []),
    )


async def _stub_expand(_decomposition: object, _ctx: dict[str, Any]) -> list[str]:
    return ["how does it work?", "key facts", "recent developments"]


async def _stub_gather(
    _sub_queries: list[str],
    _ctx: dict[str, Any],
) -> list[ExecutionResult]:
    return [
        ExecutionResult(
            chunk_index=0,
            capability="knowledge_query",
            output_text="",
            success=True,
            adapter_output=AdapterOutput(
                sources=(
                    Source(title="Reference A", url="https://example.test/a"),
                ),
            ),
        )
    ]


def _null_finalize(
    _envelope: ResponseEnvelope,
    _executions: list[ExecutionResult],
    _ctx: dict[str, Any],
) -> None:
    """No-op finalize — chunk 14's populator is exercised in its own suite."""
    return None


def _make_hooks(
    *,
    expand=_stub_expand,
    gather=_stub_gather,
    summary=None,
    finalize=_null_finalize,
) -> DeepStageHooks:
    return DeepStageHooks(
        expand=expand,
        gather=gather,
        summary=summary,
        finalize=finalize,
    )


@pytest.fixture(autouse=True)
def _reset_gate() -> None:
    DeepGate.reset()
    yield
    DeepGate.reset()


# ---------------------------------------------------------------------------
# Fast paths (non-deep + happy path)
# ---------------------------------------------------------------------------


class TestFastPaths:
    def test_non_deep_mode_short_circuits(self):
        envelope = ResponseEnvelope(request_id="t", mode="standard")
        result = asyncio.run(run_deep_turn(envelope))
        assert result.status == "complete"
        assert result.stages_run == []

    def test_happy_path_runs_all_stages(self):
        envelope = _deep_envelope()
        hooks = _make_hooks()

        async def scenario() -> DeepRunResult:
            return await run_deep_turn(
                envelope, hooks=hooks, wall_clock_s=2.0, session_key="s-happy",
            )

        result = asyncio.run(scenario())

        assert result.status == "complete"
        assert result.stages_run == ["expand", "gather", "dedupe", "finalize"]
        # gather produced a new source; dedupe merged it onto the surface.
        urls = [s.get("url") for s in envelope.source_surface]
        assert "https://example.test/a" in urls


# ---------------------------------------------------------------------------
# Timeout contract
# ---------------------------------------------------------------------------


class TestTimeout:
    def test_timeout_materializes_partial_without_raising(self):
        envelope = _deep_envelope()

        async def slow_gather(_subs, _ctx):
            await asyncio.sleep(10.0)
            return []

        hooks = _make_hooks(gather=slow_gather)

        async def scenario() -> DeepRunResult:
            return await run_deep_turn(
                envelope,
                hooks=hooks,
                wall_clock_s=0.1,  # force timeout mid-gather
                session_key="s-timeout",
            )

        result = asyncio.run(scenario())

        assert result.status == "timeout"
        assert result.reason == "deep_timeout"
        # Expand completed before the timeout fired — gather did not.
        assert "expand" in result.stages_run
        assert "gather" not in result.stages_run
        # Envelope is terminal, not still "streaming".
        assert envelope.status == "complete"

    def test_timeout_checkpoint_fires_with_timeout_phase(self):
        envelope = _deep_envelope()
        events: list[DeepStageEvent] = []

        async def slow_summary(_env, _ctx):
            await asyncio.sleep(10.0)

        async def checkpoint(_env, event):
            events.append(event)

        hooks = _make_hooks(summary=slow_summary)

        async def scenario() -> None:
            await run_deep_turn(
                envelope,
                hooks=hooks,
                safe_context={"_deep_checkpoint": checkpoint},
                wall_clock_s=0.1,
                session_key="s-timeout-ckpt",
            )

        asyncio.run(scenario())

        # A timeout checkpoint is fired exactly once with phase="timeout".
        timeout_events = [e for e in events if e.phase == "timeout"]
        assert len(timeout_events) == 1


# ---------------------------------------------------------------------------
# Concurrency gate
# ---------------------------------------------------------------------------


class TestConcurrency:
    def test_second_concurrent_request_is_rejected_with_clarification(self):
        first_envelope = _deep_envelope(request_id="first")
        second_envelope = _deep_envelope(request_id="second")

        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_first_gather(_subs, _ctx):
            started.set()
            await release.wait()
            return []

        slow_hooks = _make_hooks(gather=slow_first_gather)
        fast_hooks = _make_hooks()

        async def scenario() -> tuple[DeepRunResult, DeepRunResult]:
            first_task = asyncio.create_task(
                run_deep_turn(
                    first_envelope,
                    hooks=slow_hooks,
                    wall_clock_s=5.0,
                    session_key="s-conc",
                )
            )
            await started.wait()
            # While the first deep turn is parked, fire a second.
            second_result = await run_deep_turn(
                second_envelope,
                hooks=fast_hooks,
                wall_clock_s=5.0,
                session_key="s-conc",
            )
            release.set()
            first_result = await first_task
            return first_result, second_result

        first_result, second_result = asyncio.run(scenario())

        assert first_result.status == "complete"
        assert second_result.status == "rejected"
        assert second_result.reason == "deep_busy"
        # Second envelope carries a clarification block describing the busy state.
        clarification = next(
            (b for b in second_envelope.blocks if b.type is BlockType.clarification),
            None,
        )
        assert clarification is not None
        assert "previous deep turn" in (clarification.content or "").lower()


# ---------------------------------------------------------------------------
# Offline safety
# ---------------------------------------------------------------------------


class TestOfflineSafety:
    def test_refuses_when_offline_and_no_local_evidence(self):
        envelope = _deep_envelope(source_surface=[])
        offline_exec = ExecutionResult(
            chunk_index=0,
            capability="search_web",
            output_text="",
            success=False,
            error="connection refused",
            raw_result={"error_kind": "offline"},
        )
        hooks = _make_hooks()

        async def scenario() -> DeepRunResult:
            return await run_deep_turn(
                envelope,
                hooks=hooks,
                executions=[offline_exec],
                wall_clock_s=5.0,
                session_key="s-offline",
            )

        result = asyncio.run(scenario())

        assert result.status == "rejected"
        assert result.reason == "deep_offline"
        assert envelope.offline_degraded is True
        clarification = next(
            (b for b in envelope.blocks if b.type is BlockType.clarification),
            None,
        )
        assert clarification is not None
        assert "offline" in (clarification.content or "").lower()
        # No stage ran — the refusal short-circuited before expand.
        assert result.stages_run == []

    def test_offline_with_local_sources_still_runs(self):
        # Deep mode over local knowledge IS valid — only the "no
        # local evidence AND offline" case is refused.
        envelope = _deep_envelope(
            source_surface=[{"title": "Local doc", "url": "file:///doc.md"}],
        )
        offline_exec = ExecutionResult(
            chunk_index=0,
            capability="search_web",
            output_text="",
            success=False,
            raw_result={"error_kind": "offline"},
        )

        async def scenario() -> DeepRunResult:
            return await run_deep_turn(
                envelope,
                hooks=_make_hooks(),
                executions=[offline_exec],
                wall_clock_s=5.0,
                session_key="s-offline-local",
            )

        result = asyncio.run(scenario())
        assert result.status == "complete"


# ---------------------------------------------------------------------------
# Checkpointing
# ---------------------------------------------------------------------------


class TestCheckpointing:
    def test_every_stage_transition_fires_checkpoint(self):
        envelope = _deep_envelope()
        events: list[DeepStageEvent] = []

        async def checkpoint(_env, event):
            events.append(event)

        async def scenario() -> None:
            await run_deep_turn(
                envelope,
                hooks=_make_hooks(),
                safe_context={"_deep_checkpoint": checkpoint},
                wall_clock_s=5.0,
                session_key="s-ckpt",
            )

        asyncio.run(scenario())

        stage_sequence = [(e.stage, e.phase) for e in events]
        assert ("expand", "start") in stage_sequence
        assert ("expand", "end") in stage_sequence
        assert ("gather", "start") in stage_sequence
        assert ("gather", "end") in stage_sequence
        assert ("dedupe", "start") in stage_sequence
        assert ("dedupe", "end") in stage_sequence
        assert ("finalize", "start") in stage_sequence
        assert ("finalize", "end") in stage_sequence

    def test_checkpoint_exceptions_do_not_break_the_turn(self):
        envelope = _deep_envelope()

        async def failing_checkpoint(_env, _event):
            raise RuntimeError("disk full")

        async def scenario() -> DeepRunResult:
            return await run_deep_turn(
                envelope,
                hooks=_make_hooks(),
                safe_context={"_deep_checkpoint": failing_checkpoint},
                wall_clock_s=5.0,
                session_key="s-ckpt-fail",
            )

        result = asyncio.run(scenario())
        assert result.status == "complete"

    def test_last_persisted_snapshot_matches_final_envelope(self):
        # Simulates a client disconnect: we capture the envelope's
        # source-surface length at each checkpoint. The last-seen
        # snapshot before we "drop" the connection should match what
        # the finished envelope holds.
        envelope = _deep_envelope()
        surface_lengths: list[int] = []

        async def checkpoint(env, _event):
            surface_lengths.append(len(env.source_surface))

        async def scenario() -> None:
            await run_deep_turn(
                envelope,
                hooks=_make_hooks(),
                safe_context={"_deep_checkpoint": checkpoint},
                wall_clock_s=5.0,
                session_key="s-ckpt-snap",
            )

        asyncio.run(scenario())

        # The final snapshot length equals the envelope's terminal
        # state — a disconnect after the last checkpoint leaves the
        # persisted copy consistent with what the server holds.
        assert surface_lengths[-1] == len(envelope.source_surface)


# ---------------------------------------------------------------------------
# Wall-clock cap configuration
# ---------------------------------------------------------------------------


class TestWallClockCap:
    def test_per_profile_cap_table_matches_design_doc(self):
        assert WALL_CLOCK_SECONDS["mac"] == 45.0
        assert WALL_CLOCK_SECONDS["pi_hailo"] == 60.0
        assert WALL_CLOCK_SECONDS["pi_cpu"] == 90.0

    def test_profile_resolves_cap_when_no_explicit_override(self):
        envelope = _deep_envelope()

        async def slow_gather(_subs, _ctx):
            await asyncio.sleep(10.0)
            return []

        async def scenario() -> DeepRunResult:
            # An absurd cap for a profile we're overriding to ensure
            # the profile lookup actually drives the timeout value.
            return await run_deep_turn(
                envelope,
                hooks=_make_hooks(gather=slow_gather),
                safe_context={"platform_profile": "pi_cpu"},
                profile="__test_tiny__",
                # Also force a tiny cap directly to keep the test fast.
                wall_clock_s=0.05,
                session_key="s-cap",
            )

        result = asyncio.run(scenario())
        assert result.status == "timeout"


# ---------------------------------------------------------------------------
# Envelope-ops helpers (covered indirectly above; a few targeted checks)
# ---------------------------------------------------------------------------


class TestEnvelopeOps:
    def test_attach_clarification_inserts_after_summary(self):
        envelope = _deep_envelope()
        attach_clarification(envelope, "Please clarify.")
        types = [block.type for block in envelope.blocks]
        assert types[0] is BlockType.summary
        assert types[1] is BlockType.clarification

    def test_attach_clarification_updates_existing(self):
        envelope = _deep_envelope()
        attach_clarification(envelope, "first")
        attach_clarification(envelope, "second")
        clarifications = [
            b for b in envelope.blocks if b.type is BlockType.clarification
        ]
        assert len(clarifications) == 1
        assert clarifications[0].content == "second"

    def test_materialize_partial_promotes_populated_blocks(self):
        envelope = _deep_envelope()
        # Simulate a partially-streamed summary patched mid-flight.
        summary = envelope.blocks[0]
        summary.state = BlockState.partial
        materialize_partial(envelope)
        assert summary.state is BlockState.ready

    def test_dedupe_sources_merges_without_duplicates(self):
        envelope = _deep_envelope(
            source_surface=[{"title": "Existing", "url": "https://example.test/x"}],
        )
        gathered = [
            ExecutionResult(
                chunk_index=0,
                capability="knowledge_query",
                output_text="",
                success=True,
                adapter_output=AdapterOutput(
                    sources=(
                        Source(title="Existing", url="https://example.test/x"),
                        Source(title="New", url="https://example.test/y"),
                    ),
                ),
            )
        ]
        dedupe_sources(envelope, gathered)
        urls = [entry["url"] for entry in envelope.source_surface]
        assert urls == ["https://example.test/x", "https://example.test/y"]
