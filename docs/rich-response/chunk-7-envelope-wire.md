# Chunk 7 — Wire the envelope through synthesis + persist snapshot

## Goal

Make `run_synthesis_phase` produce a `ResponseEnvelope` alongside the legacy `ResponseObject(output_text=...)`. Introduce a minimal planner helper that allocates the initial block list (always `summary` + `sources` if any; `media` if any). Persist the canonical envelope snapshot in the existing chat-history store so history replay can use it.

Still no new SSE events and no frontend consumer changes — the envelope rides alongside today's wire payload, ready for Chunk 9 to stream it.

## Files

- `lokidoki/orchestrator/response/planner.py` — new. `plan_initial_blocks(adapter_outputs, mode) -> list[Block]` minimal implementation.
- `lokidoki/orchestrator/core/pipeline_phases.py` — `run_synthesis_phase` returns both `ResponseObject` and `ResponseEnvelope`.
- `lokidoki/orchestrator/core/types.py` — add `envelope: ResponseEnvelope | None` to `PipelineResult`.
- `lokidoki/orchestrator/core/pipeline.py` — propagate `envelope` on the final result.
- `lokidoki/api/routes/chat.py` — on turn completion, persist the envelope alongside the existing message row.
- `lokidoki/core/memory_schema.py` (or wherever `messages` CREATE TABLE lives) — add `response_envelope TEXT` column; migration-safe on existing dbs (ALTER TABLE IF NOT EXISTS pattern used elsewhere in the repo; mirror that exactly).
- `tests/unit/test_response_planner.py` — new.
- `tests/unit/test_phase_synthesis.py` — extend to assert envelope shape.

Read-only: `lokidoki/orchestrator/response/{envelope.py,blocks.py,serde.py}`, adapter files from Chunks 1–4.

## Actions

1. **Planner minimal shape** (`response/planner.py`):
   - `plan_initial_blocks(adapter_outputs: Iterable[AdapterOutput], mode: str = "standard") -> list[Block]`.
   - Always emit a `summary` block (`id="summary"`, `state=loading`).
   - If any adapter output contributes `sources`, emit `id="sources"` with `state=loading`.
   - If any adapter output contributes `media`, emit `id="media"` with `state=loading`.
   - Do NOT emit any other block type — later chunks expand the planner.
   - Mode is accepted but unused except for a future switch; keep the parameter on the signature.

2. **Synthesis wiring** (`run_synthesis_phase`):
   - After adapter outputs are aggregated (Chunk 5 left them available on the executions), call `plan_initial_blocks(...)`.
   - Build the envelope:
     - `request_id = trace.trace_id`.
     - `mode = "standard"` (planner mode selection lands in Chunk 12).
     - `status = "complete"` on successful synthesis; `"failed"` on exception.
     - Populate `blocks[summary].content = response_object.output_text`, `state = ready`.
     - Populate `blocks[sources].items = [source.to_dict() for source in aggregated_sources]`, `state = ready` (or `loading` → `omitted` if none).
     - Populate `blocks[media].items = request_spec.media`, `state = ready` or `omitted`.
     - Populate `source_surface` identically to the sources block items (duplication is fine; the surface and the inline block are two views of the same data).
     - Populate `spoken_text` from the existing synthesis spoken_text field.
   - Run `validate_envelope(envelope)` and log-warn on failure without raising (defensive — don't break the turn if the validator is too strict during rollout).
   - Return `(response_object, envelope)` from the phase.

3. **Pipeline propagation**:
   - `run_pipeline_async` threads the envelope onto `PipelineResult.envelope`.

4. **Persistence**:
   - Schema: `messages` table gets `response_envelope TEXT` column (nullable). Use an idempotent `ALTER TABLE IF NOT EXISTS`-style migration aligned with the repo's existing pattern — if the repo does schema bumps via a migration script, add the bump there instead. Confirm which pattern is in use before editing by reading `lokidoki/core/memory_schema.py` and `lokidoki/orchestrator/memory/store_schema.py`.
   - On insert: if `pipeline_result.envelope is not None`, serialize via `envelope_to_dict(...)` + `json.dumps(...)` and store.
   - On read (if any history-hydration code exists in-repo today): deserialize if present; leave legacy rows as-is.

5. **Tests**:
   - `test_response_planner.py` — planner with 0 / 1 / many adapter outputs. Asserts the required blocks appear and nothing else.
   - Extend `test_phase_synthesis.py` — run a mock calculator turn end-to-end; assert the returned envelope has summary content populated, mode="standard", status="complete".
   - Persistence test: insert a message with an envelope, read it back, assert round-trip equality via `envelope_from_dict`.

6. **No frontend changes**. Do not touch `frontend/` in this chunk. The frontend continues to consume the legacy `synthesis` SSE event unchanged.

## Verify

```
pytest tests/unit/test_response_planner.py tests/unit/test_phase_synthesis.py tests/unit/test_response_envelope.py tests/unit/test_streaming.py -v
```

All tests pass. A manual curl of `/api/v1/chat` with a calculator turn returns the legacy shape (unchanged); a sqlite inspection of the resulting `messages` row shows a populated `response_envelope` column.

## Commit message

```
feat(response): wire ResponseEnvelope through synthesis + persistence

run_synthesis_phase now produces a ResponseEnvelope alongside the
legacy ResponseObject, populated by a minimal planner that allocates
summary + sources + media blocks based on adapter output. The
envelope is persisted in messages.response_envelope so history
replay can use it.

The legacy SSE event path is unchanged; chunk 9 begins streaming
envelope-level events.

Refs docs/rich-response/PLAN.md chunk 7.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->

### Implementation notes (chunk 7)

The persistence action touched four adjacent files beyond the `## Files`
list because "persist the envelope alongside the existing message row"
has no in-repo one-line hook today:

- `lokidoki/core/memory_init.py` — added `MESSAGE_COLUMN_MIGRATIONS`
  (the repo's migration lives here, not in `memory_schema.py`).
- `lokidoki/core/memory_sql.py` — `add_message()` gained an optional
  `response_envelope` parameter.
- `lokidoki/core/memory_provider.py` — `MemoryProvider.add_message()`
  forwards `response_envelope` to the SQL writer.
- `lokidoki/orchestrator/core/streaming.py` — stashes the
  envelope-serialized JSON on the shared `safe_context` under
  `_response_envelope_json` so `chat.py` can read it after the SSE
  generator finishes. Without this, the chat route has no handle on the
  `PipelineResult` (it consumes SSE strings only).

Chunk 9 will replace the context-stash hack with a real
`response_snapshot` event stream; the chat route should then pull from
that event's payload rather than the context.
