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

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
