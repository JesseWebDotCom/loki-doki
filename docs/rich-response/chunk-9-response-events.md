# Chunk 9 — Emit `response_*` / `block_*` SSE events from the backend

## Goal

Add the new response-composition event family alongside the existing pipeline-phase events. Backend only — Chunk 10 makes the frontend consume them.

Additive. Zero breaking changes to the current `augmentation` / `decomposition` / `routing` / `synthesis` / `micro_fast_lane` phase events.

## Files

- `lokidoki/orchestrator/response/events.py` — new. Event constructors + typed shapes for the new family.
- `lokidoki/orchestrator/core/streaming.py` — extend `SSEEvent` usage sites to also emit response-composition events at the right pipeline points.
- `lokidoki/orchestrator/core/pipeline_phases.py` — hook:
  - emit `response_init` immediately after the planner runs in `run_synthesis_phase`.
  - emit `block_init` for each planned block.
  - during synthesis token streaming, emit `block_patch` for the summary block (reuse the existing token-emit site).
  - emit `source_add` when sources land.
  - emit `media_add` when media lands.
  - emit `block_ready` when each block finalizes; `block_failed` with `reason` for failures.
  - emit `response_snapshot` exactly once after the envelope is validated.
  - emit `response_done` as the terminal event.
- `tests/unit/test_response_events.py` — new.

Read-only: Chunk 6/7/8 files.

## Actions

1. **Event names and shapes** (in `response/events.py`):

   ```python
   # name -> data shape (all emitted as SSEEvent(phase=<name>, status="data", data={...}))
   # "response_init"      {"request_id", "mode", "blocks": [{"id", "type"}, ...]}
   # "block_init"         {"block_id", "type", "state": "loading"}
   # "block_patch"        {"block_id", "seq", "delta": str | None, "items_delta": list | None}
   # "block_ready"        {"block_id"}
   # "block_failed"       {"block_id", "reason"}
   # "source_add"         {"source": {...Source serialized...}}
   # "media_add"          {"media": {...MediaCard dict...}}
   # "response_snapshot"  {"envelope": {...full envelope_to_dict(...)...}}
   # "response_done"      {"request_id", "status"}
   ```

2. **Transport compatibility**. Emit these through the same `SSEEvent` class. The existing frontend handlers switch on `phase`; the new event names do not collide with existing ones. Do not add a new channel or a new `event:` SSE name field.

3. **Idempotence**. `block_patch` must include a monotonically-increasing `seq` within a given `block_id`. Reconcilers (frontend, persistence) must be able to replay patches without double-applying.

4. **Ordering rules**:
   - `response_init` is always first (after the existing `synthesis.start` phase event, not before).
   - `block_init` events immediately follow `response_init`.
   - `source_add` / `media_add` may interleave freely with `block_patch`.
   - `block_ready` for a block must follow all of its patches.
   - `response_snapshot` strictly precedes `response_done`.

5. **Snapshot**. Emit `response_snapshot` with `envelope_to_dict(envelope)` after `validate_envelope`. This is the canonical state for history replay and client reconciliation.

6. **No changes to the existing phase events**. Do NOT remove any `decomposition` / `routing` / `synthesis` event emit. The pipeline popover continues to work.

7. **Tests** (`test_response_events.py`):
   - Capture the SSE stream for a mock calculator turn; assert the event sequence contains, in order:
     `response_init → block_init{summary} → block_init{sources?} → ... → block_patch{summary,seq=...} → block_ready{summary} → response_snapshot → response_done`.
   - `seq` is monotonic per block_id.
   - `response_snapshot` data round-trips via `envelope_from_dict`.
   - Failure path: if synthesis raises, assert `block_failed` for the summary block with a non-empty `reason`, and `response_done` with `status="failed"`.

## Verify

```
pytest tests/unit/test_response_events.py tests/unit/test_streaming.py tests/unit/test_phase_synthesis.py -v
```

All tests pass. Manual: `curl -N http://localhost:8000/api/v1/chat ...` shows both the legacy phase events and the new response events interleaved.

## Commit message

```
feat(stream): emit response_* / block_* SSE composition events

Add the new event family (response_init, block_init, block_patch,
block_ready, block_failed, source_add, media_add, response_snapshot,
response_done) alongside the existing pipeline-phase events.
Additive only — no existing event is removed or renamed. The
frontend keeps consuming today's events; chunk 10 wires it to the
new ones.

seq is monotonic per block_id; patches are idempotent and
replay-safe.

Refs docs/rich-response/PLAN.md chunk 9.
```

## Deferrals

- **Token-level ``block_patch`` for the summary block.** Chunk 9 emits a single ``block_patch`` (``seq=1``) with the complete summary prose after synthesis finishes. The existing LLM token stream
  (``lokidoki/orchestrator/fallbacks/llm_fallback.py::on_token``) still emits ``synthesis:streaming`` events with per-token deltas. Routing those deltas through ``block_patch`` (monotonic ``seq``) would
  touch ``llm_fallback.py``, which is not in chunk 9's ``## Files`` list. Deferred to chunk 10 where the frontend is rewired to consume the new events and can drive the right UX shape for progressive rendering.
- **Chunk 5 / Chunk 7 ``_response_envelope_json`` shared-context hack removed.** Replaced with ``response_snapshot`` SSE interception in ``lokidoki/api/routes/chat.py``. ``chat.py`` was added to ``## Files`` under the hack-removal authorization given by chunk 7's deferral list, and ``test_streaming.py`` was updated to assert the new ``response_done`` terminal-event contract (two existing tests asserted that ``synthesis:done`` was the final event).
- **Fast-lane envelope-event emission.** Fast-lane turns bypass the synthesis phase entirely and currently emit no ``response_*`` / ``block_*`` events (only the terminal ``response_done``). Chunk 10's frontend should treat a missing ``response_init`` as the fast-lane path and render the synthesis-phase response text directly. If fast-lane parity is needed on the envelope surface, a later chunk should add a minimal ``plan_initial_blocks`` + emit path for ``_fast_lane_result``.
