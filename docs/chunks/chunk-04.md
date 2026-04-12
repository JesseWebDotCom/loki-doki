# Chunk 04 — SSE Streaming Wrapper

**Source:** `docs/v2-graduation-plan.md` §4.J.
**Prereqs:** None. Independent. **Must land before cutover (C10).**

---

## Goal

Wrap `run_pipeline_async` in an async generator that yields progressive SSE events matching the v1 frontend's expected shape, so the chat UI shows "thinking" indicators during pipeline execution.

---

## Current State

- v2 `run_pipeline_async` returns a single `PipelineResult` object. No streaming.
- v1 chat endpoint at `lokidoki/api/routes/chat.py:82-128` streams SSE events with phases like `decomposition`, `routing`, `synthesis`, etc. The frontend (`frontend/src/lib/api.ts`) consumes these.
- v2 already has per-step trace with timing at `v2/orchestrator/observability/tracing.py`.

---

## What to Build

### 1. SSE event generator
New module: `v2/orchestrator/core/streaming.py`
- Async generator wrapping `run_pipeline_async` that yields trace events as they're produced.
- Reuse `trace.timed()` callbacks from `v2/orchestrator/observability/tracing.py`.
- Map v2 phase names to v1 SSE event shapes for frontend compatibility.

### 2. v2 chat route
Either modify or add alongside the existing v1 route:
- Read `lokidoki/api/routes/chat.py:82-128` to understand v1 SSE event shapes.
- The new route calls the SSE generator and yields `text/event-stream` responses.
- Error path must return a graceful SSE error event, matching v1's `chat.py:105-128`.

### 3. Frontend compatibility
- Read `frontend/src/lib/api.ts` to understand what event names/shapes the frontend expects.
- The v2 wrapper must emit events that the existing frontend can consume without changes.

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/core/streaming.py` | New file |
| `v2/orchestrator/core/pipeline.py` | Read — understand pipeline steps and trace hooks |
| `v2/orchestrator/observability/tracing.py` | Read — understand trace event shape |
| `lokidoki/api/routes/chat.py:82-128` | Read — understand v1 SSE shape (don't edit yet) |
| `frontend/src/lib/api.ts` | Read — understand frontend event expectations |

---

## Gate Checklist

- [ ] Frontend receives at least normalize/route/synthesis phase events
- [ ] SSE error path returns a graceful event matching v1's shape
- [ ] Existing frontend chat client works with v2 SSE events without modification
