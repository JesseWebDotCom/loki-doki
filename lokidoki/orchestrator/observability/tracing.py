"""Trace helpers for the pipeline.

Wraps the lower-level :class:`TraceData` defined in ``core.types`` so the
pipeline can stamp every request with a uuid and compute a trace summary
without sprinkling logic across modules.
"""
from __future__ import annotations

import uuid

from lokidoki.orchestrator.core.types import TraceData, TraceSummary


def start_trace() -> TraceData:
    """Return an empty trace stamped with a fresh trace id."""
    trace = TraceData()
    trace.trace_id = uuid.uuid4().hex[:12]
    return trace


def build_trace_summary(trace: TraceData) -> TraceSummary:
    """Compute aggregate timings + slowest step from a populated trace."""
    if not trace.steps:
        return TraceSummary(total_timing_ms=0.0, step_count=0)
    total = sum(step.timing_ms for step in trace.steps)
    slowest = max(trace.steps, key=lambda step: step.timing_ms)
    return TraceSummary(
        total_timing_ms=round(total, 3),
        slowest_step_name=slowest.name,
        slowest_step_timing_ms=slowest.timing_ms,
        step_count=len(trace.steps),
    )
