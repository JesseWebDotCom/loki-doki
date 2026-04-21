# Chunk 10 — Frontend consumes response events + progressive rendering + history replay

## Goal

Move the frontend off client-derived blocks (Chunk 8) and onto the real `ResponseEnvelope` streamed from the backend (Chunk 9). Render the assistant shell + block skeletons as soon as `response_init` arrives, before synthesis completes. Hydrate blocks from `block_patch` / `block_ready` events. Use `response_snapshot` as the canonical stored state for history replay.

After this chunk: time-to-first-shell p95 < 250 ms on `pi_cpu` is achievable, and reopening a chat re-renders from the snapshot with zero inference.

## Files

- `frontend/src/lib/response-reducer.ts` — new. Pure reducer: `(envelope, event) -> envelope`.
- `frontend/src/lib/api.ts` — extend `onEvent` / event dispatch to route response-family events into the reducer.
- `frontend/src/pages/ChatPage.tsx` — hold a per-turn `ResponseEnvelope` in state; render via the reducer; persist the snapshot.
- `frontend/src/components/chat/MessageItem.tsx` — consume `envelope.blocks` when present; fall back to the client-derived shape when absent (legacy history rows).
- `frontend/src/components/chat/__tests__/response-reducer.test.ts` — new.

Read-only: Chunk 8 block renderers, Chunk 9 event shapes.

## Actions

1. **Reducer** (`response-reducer.ts`). Pure, deterministic, no side effects:

   ```ts
   export function reduce(env: ResponseEnvelope, ev: PipelineEvent): ResponseEnvelope {
     switch (ev.phase) {
       case "response_init":    return initEnvelope(ev.data);
       case "block_init":       return upsertBlock(env, ev.data);
       case "block_patch":      return patchBlock(env, ev.data);
       case "block_ready":      return setBlockState(env, ev.data.block_id, "ready");
       case "block_failed":     return setBlockState(env, ev.data.block_id, "failed", ev.data.reason);
       case "source_add":       return appendSource(env, ev.data.source);
       case "media_add":        return appendMedia(env, ev.data.media);
       case "response_snapshot":return deserializeSnapshot(ev.data.envelope);  // wins over prior deltas
       case "response_done":    return { ...env, status: ev.data.status };
       default:                 return env;
     }
   }
   ```

2. **`block_patch` semantics**:
   - If `delta` is present, append it to `block.content` (summary-type blocks).
   - If `items_delta` is present, append each item to `block.items` (list-type blocks).
   - Use `seq` to guard against out-of-order replays: if the incoming `seq` is ≤ the last-applied seq for that block, drop silently.
   - Flip `state` to `partial` on first patch if currently `loading`.

3. **Snapshot reconciliation**. `response_snapshot` *replaces* the envelope entirely — it is the authoritative server-side reconciled state. Deltas after a snapshot should not arrive (Chunk 9 enforces ordering); if one does, apply it anyway (the reducer is tolerant).

4. **ChatPage wiring**:
   - Each streaming turn owns a `ResponseEnvelope` state (initially undefined).
   - `onEvent` routes response-family events through `reduce` and updates state.
   - Existing pipeline phase state (`PipelineState`) stays separate — it drives `PipelineInfoPopover` as today.
   - When `response_done` arrives with `status="complete"`, persist the envelope into chat history (backend already stores it — see Chunk 7; frontend just updates its local message cache).

5. **MessageItem dual-source logic**:
   - If `message.envelope` is present (from live stream or history), render via the block registry as in Chunk 8.
   - Else derive blocks from `message.synthesis` client-side (legacy path — preserved for pre-envelope messages).

6. **History replay**:
   - The existing history fetch path returns persisted messages. If a message row has a non-null `response_envelope`, parse it client-side via `envelope_from_dict` (TS implementation — add to `response-types.ts` if Chunk 6 didn't already include one) and render via blocks.
   - Replay must not re-invoke synthesis. Verify by asserting no `POST /api/v1/chat` is fired on history load.

7. **Timing instrumentation**:
   - Record `performance.now()` at three marks: `shellVisible` (on `response_init`), `firstBlockReady` (on the first `block_ready`), `snapshotApplied` (on `response_snapshot`).
   - Surface these in the existing `PipelineInfoPopover` under a new "Render timings" section (so a dev can validate §14.6 targets on `pi_cpu`).

8. **Tests** (`response-reducer.test.ts`):
   - Reducer applies a full event sequence (init → blocks → patches → ready → snapshot → done) and produces the expected envelope.
   - Out-of-order seq is idempotent.
   - Snapshot fully replaces prior state.
   - Unknown event phase is a no-op.
   - Failure path: `block_failed` sets `state` + `reason`.

## Verify

```
npm --prefix frontend run test -- response-reducer && npm --prefix frontend run build && pytest tests/unit/test_streaming.py -v
```

Tests pass. Build succeeds. Manual: run `./run.sh`, send a query, verify the assistant shell appears within ~250 ms on mac, then hydrates progressively. Reopen the chat — it renders from the snapshot with no network tab activity.

## Commit message

```
feat(chat): consume response events + progressive rendering

The frontend now holds a per-turn ResponseEnvelope reduced from
response_init / block_init / block_patch / block_ready /
block_failed / source_add / media_add / response_snapshot /
response_done events. MessageItem renders the envelope directly;
legacy history rows without a snapshot fall back to client-derived
blocks.

History replay hydrates from the persisted snapshot — no synthesis
reruns on chat load.

Refs docs/rich-response/PLAN.md chunk 10.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
