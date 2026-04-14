"""Phase 6 streaming trace listener coverage."""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import TraceData, TraceStep


def test_trace_listener_receives_step_for_each_add():
    received: list[TraceStep] = []
    trace = TraceData()
    trace.subscribe(received.append)

    trace.add("normalize", timing_ms=1.2, cleaned_text="hello")
    trace.add("parse", timing_ms=11.4)

    assert [step.name for step in received] == ["normalize", "parse"]
    assert received[0].details["cleaned_text"] == "hello"
    assert received[1].timing_ms == 11.4


def test_trace_listener_failure_does_not_break_trace():
    """A misbehaving listener must not corrupt the trace or stop later steps."""
    good: list[TraceStep] = []

    def boom(_step: TraceStep) -> None:
        raise RuntimeError("listener exploded")

    trace = TraceData()
    trace.subscribe(boom)
    trace.subscribe(good.append)

    trace.add("normalize")
    trace.add("parse")

    assert [step.name for step in good] == ["normalize", "parse"]
    assert [step.name for step in trace.steps] == ["normalize", "parse"]


@pytest.mark.anyio
async def test_pipeline_emits_steps_to_trace_listener_in_order():
    """End-to-end: a listener attached before run sees every step."""
    from lokidoki.orchestrator.core.pipeline import run_pipeline_async

    received: list[str] = []

    # The pipeline starts a fresh trace internally; to subscribe, we
    # monkey-patch start_trace to install our listener on the new trace.
    from lokidoki.orchestrator.observability import tracing as tracing_module

    original_start_trace = tracing_module.start_trace

    def start_with_listener():
        trace = original_start_trace()
        trace.subscribe(lambda step: received.append(step.name))
        return trace

    tracing_module.start_trace = start_with_listener
    try:
        # Also patch the binding inside the pipeline module since it
        # imported the symbol directly.
        from lokidoki.orchestrator.core import pipeline as pipeline_module

        original_pipeline_start = pipeline_module.start_trace
        pipeline_module.start_trace = start_with_listener
        try:
            await run_pipeline_async("hello and how do you spell restaurant")
        finally:
            pipeline_module.start_trace = original_pipeline_start
    finally:
        tracing_module.start_trace = original_start_trace

    # Streaming order must match the pipeline contract.
    assert received[0] == "normalize"
    assert "parse" in received
    assert "route" in received
    assert "execute" in received
    # combine and media_augment run concurrently at the tail of the
    # pipeline — both must fire, and the terminal step is whichever
    # finishes last. Assert membership, not strict trailing order.
    assert "combine" in received
    assert "media_augment" in received
    assert received[-1] in {"combine", "media_augment"}
