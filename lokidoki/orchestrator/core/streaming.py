"""SSE streaming wrapper for the pipeline.

Wraps ``run_pipeline_async`` in an async generator that yields progressive
SSE events matching the frontend's expected ``PipelineEvent`` shape
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
    """Pipeline SSE event."""

    phase: str
    status: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_sse(self) -> str:
        """Serialize to the ``data: <json>\n\n`` SSE wire format."""
        payload = {"phase": self.phase, "status": self.status, "data": self.data}
        return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


# Which frontend phase each trace step contributes timing to.
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
    "loop_execute_search": "routing",
}

# Sentinel pushed to the queue when the pipeline task finishes.
_DONE = object()


async def stream_pipeline_sse(
    raw_text: str,
    context: dict[str, Any] | None = None,
) -> AsyncGenerator[str, None]:
    """Run the pipeline and yield ``data: {...}\\n\\n`` SSE strings."""
    from lokidoki.orchestrator.core.pipeline import run_pipeline_async

    queue: asyncio.Queue[SSEEvent | object] = asyncio.Queue()
    safe_context = dict(context or {})

    phase_timing: dict[str, float] = {}
    step_cache: dict[str, TraceStep] = {}

    def _on_step(step: TraceStep) -> None:
        """Trace listener — fires synchronously inside ``trace.add()``."""
        v1_phase = _STEP_TO_PHASE.get(step.name)
        if v1_phase:
            phase_timing[v1_phase] = phase_timing.get(v1_phase, 0) + step.timing_ms
        step_cache[step.name] = step
        event = _step_to_sse_event(step, step_cache, phase_timing)
        if event is not None:
            queue.put_nowait(event)

    safe_context["_trace_listener"] = _on_step
    safe_context["_sse_queue"] = queue

    task = asyncio.create_task(
        _run_pipeline_task(raw_text, safe_context, queue, run_pipeline_async)
    )
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


def _step_to_sse_event(
    step: TraceStep,
    step_cache: dict[str, TraceStep],
    phase_timing: dict[str, float],
) -> SSEEvent | None:
    """Map a single trace step to an SSE phase event, or None if no transition."""
    if step.name == "normalize":
        return SSEEvent(phase="decomposition", status="active", data={"activity": "Understanding…"})
    if step.name == "route":
        return _route_active_event(step)
    if step.name == "combine":
        return _combine_active_event(step, step_cache)
    if step.name == "fast_lane" and step.details.get("matched"):
        return _fast_lane_event(step)
    if step.name == "extract":
        return SSEEvent("decomposition", "done", _build_decomposition_data(step_cache, phase_timing))
    if step.name == "execute":
        return SSEEvent("routing", "done", _build_routing_data(step_cache, phase_timing))
    if step.name == "memory_read":
        return SSEEvent("augmentation", "done", _memory_read_data(step, phase_timing, step_cache))
    return None


def _route_active_event(step: TraceStep) -> SSEEvent:
    """Build a descriptive routing active event from route step details."""
    chunks = step.details.get("chunks") or []
    if chunks:
        skills = [_human_skill_name(c.get("capability", "")) for c in chunks if c.get("capability") != "direct_chat"]
        queries = [c.get("text", "").strip() for c in chunks if c.get("text")]
        if skills and queries:
            activity = f"Searching {queries[0][:60]}"
        elif skills:
            activity = f"Looking up {', '.join(skills[:2])}"
        else:
            activity = "Thinking about this…"
    else:
        activity = "Routing…"
    return SSEEvent(phase="routing", status="active", data={"activity": activity})


def _combine_active_event(step: TraceStep, step_cache: dict[str, TraceStep]) -> SSEEvent:
    """Build a descriptive synthesis active event."""
    execute_step = step_cache.get("execute")
    if execute_step:
        exec_chunks = execute_step.details.get("chunks") or []
        successful = [c for c in exec_chunks if c.get("success")]
        if successful:
            cap = successful[0].get("capability", "")
            activity = f"Composing answer from {_human_skill_name(cap)}"
        else:
            activity = "Generating response…"
    else:
        activity = "Generating response…"
    return SSEEvent(phase="synthesis", status="active", data={"activity": activity})


def _human_skill_name(capability: str) -> str:
    """Convert a capability ID to a human-readable label."""
    _MAP = {
        "knowledge_query": "Wikipedia",
        "search_web": "web search",
        "direct_chat": "knowledge",
        "get_weather": "weather",
        "lookup_movie": "movies",
        "movie_showtimes": "showtimes",
        "youtube_search": "YouTube",
        "dictionary_lookup": "dictionary",
        "unit_conversion": "converter",
        "people_lookup": "people",
        "sports_scores": "sports",
    }
    return _MAP.get(capability, capability.replace("_", " "))


def _fast_lane_event(step: TraceStep) -> SSEEvent:
    """Return the micro_fast_lane done event."""
    return SSEEvent(
        phase="micro_fast_lane",
        status="done",
        data={"hit": True, "category": step.details.get("capability", ""), "latency_ms": round(step.timing_ms, 1)},
    )


def _memory_read_data(
    step: TraceStep,
    phase_timing: dict[str, float],
    step_cache: dict[str, TraceStep],
) -> dict[str, Any]:
    """Build augmentation done data from the memory_read step."""
    slots = step.details.get("slots_assembled", [])
    # Build per-slot char counts for the UI (e.g. "user_facts: 120 chars")
    slot_details: list[dict[str, Any]] = []
    for slot_name in slots:
        chars = step.details.get(f"{slot_name}_chars", 0)
        if chars > 0:
            slot_details.append({"name": slot_name, "chars": chars})
    # Count entities from session bridge (from memory_write step details)
    mw_step = step_cache.get("memory_write")
    entity_count = 0
    if mw_step:
        entity_count = mw_step.details.get("entity_count", 0)
    relevant_facts = sum(1 for s in slot_details if s["name"] in (
        "user_facts", "social_context", "relevant_episodes",
    ))
    return {
        "latency_ms": round(phase_timing.get("augmentation", 0), 1),
        "slots_assembled": slots,
        "slot_details": slot_details,
        "relevant_facts": relevant_facts,
        "context_messages": 0,  # filled by frontend from conversation_history
        "session_entities": entity_count,
    }


async def _run_pipeline_task(
    raw_text: str,
    safe_context: dict[str, Any],
    queue: "asyncio.Queue[SSEEvent | object]",
    run_pipeline_async: Any,
) -> None:
    """Run the pipeline and push the final synthesis event (or error) onto the queue."""
    try:
        result = await run_pipeline_async(raw_text, context=safe_context)
        
        # Persist the trace to the database if a provider and message ID are available.
        # This is what makes the 'steps' sticky in the UI across reloads.
        memory = safe_context.get("memory_provider")
        user_id = safe_context.get("owner_user_id")
        session_id = safe_context.get("session_id")
        user_message_id = safe_context.get("user_message_id")
        
        if memory and user_id and session_id:
            try:
                # TraceData contains the structured steps recorded during execution.
                from lokidoki.orchestrator.core.types import TraceData
                if hasattr(result, "trace") and isinstance(result.trace, TraceData):
                    await memory.add_chat_trace(
                        user_id=int(user_id),
                        session_id=int(session_id),
                        user_message_id=int(user_message_id) if user_message_id else None,
                        trace_result=result,
                    )
                    logger.info("[Stream] Persisted chat trace for session %s msg %s", session_id, user_message_id)
            except Exception:
                logger.exception("Failed to persist chat trace to DB")

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


# ---- phase data builders ------------------------------------------------


def _build_decomposition_data(
    step_cache: dict[str, TraceStep],
    phase_timing: dict[str, float],
) -> dict[str, Any]:
    """Build decomposition ``done`` data."""
    split_step = step_cache.get("split")
    signals_step = step_cache.get("signals")
    data: dict[str, Any] = {
        "model": "pipeline",
        "latency_ms": round(phase_timing.get("decomposition", 0), 1),
        "is_course_correction": False,
    }
    if split_step:
        data["asks"] = [
            {"ask_id": f"chunk_{i}", "distilled_query": text, "resolved_query": text}
            for i, text in enumerate(split_step.details.get("chunks", []))
        ]
    if signals_step:
        data["reasoning_complexity"] = signals_step.details.get("urgency", "low")
    return data


def _build_routing_data(
    step_cache: dict[str, TraceStep],
    phase_timing: dict[str, float],
) -> dict[str, Any]:
    """Build routing ``done`` data."""
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
            "intent": rc.get("capability") or "",
            "status": "success" if ec.get("success", False) else "failed",
            "skill_id": rc.get("capability") or ec.get("capability") or "",
            "mechanism": ec.get("handler_name") or "",
            "latency_ms": round(ec.get("timing_ms", 0), 1),
        })

    return {
        "skills_resolved": resolved,
        "skills_failed": failed,
        "routing_log": routing_log,
        "latency_ms": round(phase_timing.get("routing", 0), 1),
    }


def _build_synthesis_done(result: Any) -> dict[str, Any]:
    """Build synthesis ``done`` data from a PipelineResult."""
    return {
        "response": result.response.output_text,
        "model": getattr(result.request_spec, "llm_model", None) or "pipeline",
        "latency_ms": round(result.trace_summary.total_timing_ms, 1),
        "tone": "neutral",
        "sources": _extract_sources(result),
        "media": list(getattr(result.request_spec, "media", []) or []),
        "platform": "lokidoki",
        "trace_snapshot": [step.to_dict() for step in getattr(getattr(result, "trace", None), "steps", [])],
    }


def _extract_sources(result: Any) -> list[dict[str, str]]:
    """Extract source attribution from the request spec.

    Uses the same ``_collect_sources`` logic the LLM prompt builder uses
    so that ``[src:N]`` citation markers in the response text map to the
    correct index in the list the frontend receives.  The previous
    implementation iterated ``result.executions`` independently, which
    could diverge from the spec-based list when the knowledge-gap
    fallback appended extra executions.
    """
    from lokidoki.orchestrator.fallbacks.llm_prompt_builder import _collect_sources

    spec = getattr(result, "request_spec", None)
    if spec is not None:
        return _collect_sources(spec)
    return []


def _build_error_event() -> SSEEvent:
    """Graceful SSE error event matching the frontend's expected shape."""
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
