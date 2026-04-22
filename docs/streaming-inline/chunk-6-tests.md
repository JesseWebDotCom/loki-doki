# Chunk 6 — Tests: progressive-in-place, history replay, fast-lane fallback

## Goal

Lock in the behavior from chunks 1-5 with vitest + React Testing Library coverage. Prevent regressions to the streaming-inline path, the history-replay path, and the fast-lane (no-envelope) path.

## Files

Touch:
- `frontend/src/components/chat/__tests__/MessageItem.test.tsx` (extend)
- `frontend/src/components/chat/__tests__/streamingInline.test.tsx` (new)
- `frontend/src/pages/__tests__/chatPageStreaming.test.tsx` (new if absent; extend if present — locate via `rg -n "describe" frontend/src/pages/__tests__`)

Read-only reference:
- `frontend/src/utils/responseReducer.ts`
- Existing chunk-10/chunk-16 tests under `frontend/src/components/chat/__tests__/` for fixture patterns.

## Actions

1. **Reducer test — streaming → complete flip (`streamingInline.test.tsx`):** feed `response_init` → `block_patch × N` → `response_snapshot` → `response_done`. Assert: final envelope has `status === 'complete'`; summary block `state === 'ready'`; sources block either `'ready'` or `'omitted'`; partial-state content is preserved through snapshot adoption.
2. **Component test — in-place render:** mount `MessageItem` with an envelope sequence starting at `status: 'streaming'` and walk through deltas via rerender. Assert: one DOM node for the bubble throughout; `SummaryBlock` text grows monotonically; caret visible during streaming, absent at complete; sources absent until final `ready`.
3. **`ChatPage` integration — single bubble invariant:** mock `sendChatMessage` to dispatch `response_init` + several `block_patch`es + `response_snapshot` + `response_done`. Assert: `screen.getAllByRole('article')` (or whatever the MessageItem role is) has exactly `userMessageCount + 1` nodes at every tick after `response_init`. No double-bubble flash.
4. **Fast-lane fallback:** mock a turn that emits legacy `synthesis:done` but no `response_init`. Assert: exactly one assistant message appended, content matches legacy path, no crashes, no in-progress bubble ever mounted.
5. **History replay:** mount `ChatPage` with a seeded `messages` array that has `envelope.status: 'complete'` on old turns. Assert: first paint renders blocks identically to today; no streaming chrome visible.
6. **Session-bleed:** dispatch `response_init` on session A, then change `currentSessionIdRef` to session B, dispatch `response_done`. Assert: the in-progress bubble is removed; no orphan message in either session's state.
7. **TTS idempotency:** mock `tts.speak`. Assert it's called exactly once per `messageKey` across the whole turn, even if `response_snapshot` arrives after `response_done` (shouldn't, but guard the case).

## Verify

```
cd frontend && npx vitest run src/components/chat/__tests__/ src/pages/__tests__/ src/utils/__tests__/ 2>/dev/null
```

All new and existing tests pass. Coverage of `ChatPage`'s streaming branches ≥ chunk-10 levels.

## Commit message

```
test(streaming-inline): lock in progressive-in-place rendering

Covers: reducer streaming → complete flip, single-bubble invariant
across the full SSE sequence, fast-lane fallback (no envelope),
history replay identity, session-bleed cleanup of the in-progress
bubble, TTS idempotency. Prevents regressions to the chunk-10
progressive-rendering path and the chunk-16 one-call TTS contract.

Refs docs/streaming-inline/PLAN.md chunk 6.
```

## Deferrals

(append-only)
