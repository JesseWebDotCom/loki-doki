"""SSE streaming wrapper for the pipeline.

Wraps ``run_pipeline_async`` in an async generator that yields progressive
SSE events matching the v1 frontend's expected ``PipelineEvent`` shape
(``{phase, status, data}``), so the chat UI shows phase indicators during
pipeline execution without any frontend changes.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from lokidoki.orchestrator.core.types import TraceStep

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SSEEvent:
    """V1-compatible pipeline event."""

    phase: str
    status: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_sse(self) -> str:
        """Serialize to the ``data: <json>\n\n`` SSE wire format."""
        payload = {"phase": self.phase, "status": self.status, "data": self.data}
        return f"data: {json.dumps(payload)}\n\n"


# Which v1 phase each trace step contributes timing to.
_STEP_TO_PHASE: dict[str, str] = {
    "normalize": "decomposition",
    "signals": "decomposition",
    "parse": "decomposition",
    "split": "decomposition",
    "extract": "decomposition",
    "memory_write": "augmentation",
    "memory_read": "augmentation",
    "route": "routing",
    "select_implementation": "routing",
    "resolve": "routing",
    "execute": "routing",
    "request_spec": "synthesis",
    "combine": "synthesis",
}

# Sentinel pushed to the queue when the pipeline task finishes.
_DONE = object()


async def stream_pipeline_sse(
    raw_text: str,
    context: dict[str, Any] | None = None,
) -> AsyncGenerator[str, None]:
    """Run the pipeline and yield v1-compatible SSE events.

    The generator yields ``data: {...}\\n\\n`` strings that the existing
    frontend ``parseSseEvent()`` can consume directly.  Callers should
    wrap the return value in a ``StreamingResponse(media_type="text/event-stream")``.
    """
    from lokidoki.orchestrator.core.pipeline import run_pipeline_async

    queue: asyncio.Queue[SSEEvent | object] = asyncio.Queue()
    safe_context = dict(context or {})

    # Accumulate timing per v1 phase for "done" events.
    phase_timing: dict[str, float] = {}
    # Cache each step so "done" builders can read sibling details.
    step_cache: dict[str, TraceStep] = {}

    def _on_step(step: TraceStep) -> None:
        """Trace listener — fires synchronously inside ``trace.add()``."""
        v1_phase = _STEP_TO_PHASE.get(step.name)
        if v1_phase:
            phase_timing[v1_phase] = phase_timing.get(v1_phase, 0) + step.timing_ms
        step_cache[step.name] = step

        # ---- phase transitions at specific step boundaries ----

        if step.name == "normalize":
            queue.put_nowait(SSEEvent(phase="decomposition", status="active"))

        elif step.name == "extract":
            queue.put_nowait(SSEEvent(
                phase="decomposition",
                status="done",
                data=_build_decomposition_data(step_cache, phase_timing),
            ))

        elif step.name == "fast_lane" and step.details.get("matched"):
            queue.put_nowait(SSEEvent(
                phase="micro_fast_lane",
                status="done",
                data={
                    "hit": True,
                    "category": step.details.get("capability", ""),
                    "latency_ms": round(step.timing_ms, 1),
                },
            ))

        elif step.name == "route":
            queue.put_nowait(SSEEvent(phase="routing", status="active"))

        elif step.name == "execute":
            queue.put_nowait(SSEEvent(
                phase="routing",
                status="done",
                data=_build_routing_data(step_cache, phase_timing),
            ))

        elif step.name == "memory_read":
            queue.put_nowait(SSEEvent(
                phase="augmentation",
                status="done",
                data={
                    "latency_ms": round(phase_timing.get("augmentation", 0), 1),
                    "slots_assembled": step.details.get("slots_assembled", []),
                },
            ))

        elif step.name == "combine":
            queue.put_nowait(SSEEvent(phase="synthesis", status="active"))

    safe_context["_trace_listener"] = _on_step

    async def _run() -> None:
        try:
            result = await run_pipeline_async(raw_text, context=safe_context)
            queue.put_nowait(SSEEvent(
                phase="synthesis",
                status="done",
                data=_build_synthesis_done(result),
            ))
        except Exception:
            logger.exception("pipeline crashed during SSE stream")
            queue.put_nowait(_build_error_event())
        finally:
            queue.put_nowait(_DONE)

    task = asyncio.create_task(_run())
    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                break
            assert isinstance(item, SSEEvent)
            yield item.to_sse()
    finally:
        if not task.done():
            task.cancel()


# ---- phase data builders ------------------------------------------------


def _build_decomposition_data(
    step_cache: dict[str, TraceStep],
    phase_timing: dict[str, float],
) -> dict[str, Any]:
    """Build v1-compatible decomposition ``done`` data."""
    split_step = step_cache.get("split")
    signals_step = step_cache.get("signals")
    data: dict[str, Any] = {
        "model": "pipeline",
        "latency_ms": round(phase_timing.get("decomposition", 0), 1),
        "is_course_correction": False,
    }
    if split_step:
        data["asks"] = [
            {"ask_id": f"chunk_{i}", "distilled_query": text}
            for i, text in enumerate(split_step.details.get("chunks", []))
        ]
    if signals_step:
        data["reasoning_complexity"] = signals_step.details.get("urgency", "low")
    return data


def _build_routing_data(
    step_cache: dict[str, TraceStep],
    phase_timing: dict[str, float],
) -> dict[str, Any]:
    """Build v1-compatible routing ``done`` data."""
    execute_step = step_cache.get("execute")
    route_step = step_cache.get("route")
    exec_chunks = execute_step.details.get("chunks", []) if execute_step else []
    route_chunks = route_step.details.get("chunks", []) if route_step else []

    resolved = sum(1 for c in exec_chunks if c.get("success"))
    failed = sum(1 for c in exec_chunks if not c.get("success"))

    routing_log = []
    for rc in route_chunks:
        idx = rc.get("chunk_index")
        ec = next(
            (e for e in exec_chunks if e.get("chunk_index") == idx),
            {},
        )
        routing_log.append({
            "ask_id": f"chunk_{idx}",
            "intent": rc.get("capability", ""),
            "status": "success" if ec.get("success", False) else "failed",
            "skill_id": rc.get("capability", ""),
            "mechanism": ec.get("capability", ""),
            "latency_ms": round(ec.get("timing_ms", 0), 1),
        })

    return {
        "skills_resolved": resolved,
        "skills_failed": failed,
        "routing_log": routing_log,
        "latency_ms": round(phase_timing.get("routing", 0), 1),
    }


def _build_synthesis_done(result: Any) -> dict[str, Any]:
    """Build v1-compatible synthesis ``done`` data from a PipelineResult."""
    return {
        "response": result.response.output_text,
        "model": getattr(result.request_spec, "llm_model", None) or "pipeline",
        "latency_ms": round(result.trace_summary.total_timing_ms, 1),
        "tone": "neutral",
        "sources": _extract_sources(result),
        "platform": "lokidoki",
    }


def _extract_sources(result: Any) -> list[dict[str, str]]:
    """Extract source attribution from execution results."""
    sources: list[dict[str, str]] = []
    for execution in getattr(result, "executions", []):
        raw = getattr(execution, "raw_result", {}) or {}
        for src in raw.get("sources", []):
            if isinstance(src, dict) and src.get("url"):
                sources.append({
                    "url": src["url"],
                    "title": src.get("title", ""),
                })
    return sources


def _build_error_event() -> SSEEvent:
    """Graceful SSE error event matching v1's shape."""
    return SSEEvent(
        phase="synthesis",
        status="done",
        data={
            "response": "Something went wrong on my end. "
                        "Check the backend logs for details.",
            "model": "error",
            "latency_ms": 0,
            "tone": "neutral",
            "sources": [],
            "error": True,
        },
    )
