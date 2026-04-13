"""Tests for the stdlib ANSI trace console renderer (Phase 6)."""
from __future__ import annotations

import io

import pytest

from lokidoki.orchestrator.core.types import TraceData, TraceStep
from lokidoki.orchestrator.observability.console import attach_console_renderer, render_step


def test_render_step_plain_format_contains_name_status_and_timing():
    step = TraceStep(name="parse", status="done", timing_ms=11.42, details={})
    line = render_step(step, use_color=False)
    assert "parse" in line
    assert "done" in line
    assert "11.42" in line
    # No ANSI escapes when colour is disabled.
    assert "\x1b[" not in line


def test_render_step_color_format_contains_ansi_escapes():
    step = TraceStep(name="route", status="done", timing_ms=3.21, details={"capability": "get_current_time"})
    line = render_step(step, use_color=True)
    assert "\x1b[" in line
    assert "route" in line
    assert "get_current_time" in line


def test_render_step_truncates_long_detail_values():
    long_text = "x" * 200
    step = TraceStep(
        name="normalize",
        status="done",
        timing_ms=0.1,
        details={"cleaned_text": long_text},
    )
    line = render_step(step, use_color=False)
    # Truncated to 37 chars + ellipsis.
    assert "x" * 37 + "…" in line
    assert long_text not in line


def test_render_step_handles_unknown_step_name_and_status():
    step = TraceStep(name="custom_step", status="warn", timing_ms=0.5, details={})
    line = render_step(step, use_color=False)
    assert "custom_step" in line
    assert "warn" in line


def test_attach_console_renderer_writes_each_step_to_stream():
    buf = io.StringIO()
    trace = TraceData()
    attach_console_renderer(trace, stream=buf, use_color=False)

    trace.add("normalize", timing_ms=0.5, cleaned_text="hello")
    trace.add("parse", timing_ms=11.4)
    trace.add("execute", timing_ms=42.0, output_text="result")

    output = buf.getvalue()
    assert output.count("\n") == 3
    assert "normalize" in output
    assert "parse" in output
    assert "execute" in output
    assert "11.40" in output


def test_attach_console_renderer_isolates_stream_failures():
    """A broken stream must not break the trace itself."""

    class BrokenStream:
        def write(self, _value):
            raise IOError("disk full")

        def flush(self):
            raise IOError("disk full")

    trace = TraceData()
    attach_console_renderer(trace, stream=BrokenStream(), use_color=False)

    # Must not raise even though the stream is broken.
    trace.add("normalize", timing_ms=0.1)
    trace.add("parse", timing_ms=11.0)

    assert [step.name for step in trace.steps] == ["normalize", "parse"]


@pytest.mark.anyio
async def test_attach_console_renderer_streams_full_pipeline_run():
    """End-to-end: every pipeline step should land on the renderer stream."""
    from lokidoki.orchestrator.core import pipeline as pipeline_module
    from lokidoki.orchestrator.observability import tracing as tracing_module

    buf = io.StringIO()
    captured_lines: list[str] = []

    original_start_trace = tracing_module.start_trace

    def start_with_renderer():
        trace = original_start_trace()
        attach_console_renderer(trace, stream=buf, use_color=False)
        return trace

    tracing_module.start_trace = start_with_renderer
    pipeline_module.start_trace = start_with_renderer
    try:
        from lokidoki.orchestrator.core.pipeline import run_pipeline_async

        await run_pipeline_async("hello and how do you spell restaurant")
    finally:
        tracing_module.start_trace = original_start_trace
        pipeline_module.start_trace = original_start_trace

    output = buf.getvalue()
    captured_lines = [line for line in output.split("\n") if line.strip()]

    assert any("normalize" in line for line in captured_lines)
    assert any("parse" in line for line in captured_lines)
    assert any("execute" in line for line in captured_lines)
    assert any("combine" in line for line in captured_lines)
