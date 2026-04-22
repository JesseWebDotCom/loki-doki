# Chunk 2 — Push in-progress assistant message on `response_init`

## Goal

On `response_init`, push a placeholder assistant message onto `messages` with `envelope: liveEnvelope` and `pipeline.phase: 'streaming'`. On every subsequent response-family event, update the **last** message's `envelope` in place from `liveEnvelope`. The final `MessageItem` bubble now exists from the first delta — rendering is chunk 3.

## Files

Touch:
- `frontend/src/pages/ChatPage.tsx`

Read-only reference:
- `frontend/src/types/messages.ts` (or wherever the chat message type is defined — locate via `rg -n "ChatMessage|AssistantMessage" frontend/src/types`)
- `frontend/src/components/chat/MessageItem.tsx`

## Actions

1. In the `isResponseEvent` branch of `handleEvent` (ChatPage.tsx L628–674), detect `event.phase === RESPONSE_INIT` BEFORE the existing `reduceResponse` call so `liveEnvelope` is already built when we push.
2. On `RESPONSE_INIT`:
   - Build a placeholder message: `role: 'assistant'`, `content: ''`, `timestamp: createMessageTimestamp()`, `sources: []`, `media: []`, `pipeline: { ...INITIAL_PIPELINE, phase: 'streaming' }`, `envelope: envelopeRef.current`.
   - Append it via `setMessages(msgs => [...msgs, placeholder])`.
   - Record its index in a new `useRef<number | null>(null)` called `inProgressMessageIndexRef`. Null it at turn start.
3. On every subsequent response-family event (after `reduceResponse` runs), if `inProgressMessageIndexRef.current != null`, update that message's `envelope` in place: `setMessages(msgs => msgs.map((m, i) => i === inProgressMessageIndexRef.current ? { ...m, envelope: envelopeRef.current } : m))`.
4. Do **not** change the end-of-turn append path yet (chunk 5 handles completion). Today it will duplicate — one in-progress message + one final. Acceptable for this chunk; add a temporary dedupe guard: if `inProgressMessageIndexRef.current != null` at end-of-turn, skip the existing `setMessages(msgs => [...msgs, …])` append.
5. Respect the session-bleed guard (L803–806): if `turnBelongsToCurrentView === false`, also remove the in-progress placeholder via `setMessages(msgs => msgs.filter((_, i) => i !== inProgressMessageIndexRef.current))`.
6. Ensure fast-lane path (no `response_init` ever fires) is unaffected — `inProgressMessageIndexRef.current` stays `null`, so the existing end-of-turn append runs as today.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/ src/pages/__tests__/ 2>/dev/null
```

Manual: `npm run dev`. Send a non-fast-lane turn ("tell me about mitochondria"). Confirm only **one** assistant bubble appears in the DOM at end of turn (not two). Send a fast-lane turn ("what time is it") and confirm behavior unchanged.

## Commit message

```
feat(streaming-inline): push in-progress bubble on response_init

Places an assistant ``MessageItem`` in the messages array as soon as
``response_init`` arrives, so subsequent ``block_patch`` events update
a bubble that already exists rather than living only inside
``ThinkingIndicator``. End-of-turn append is short-circuited when an
in-progress bubble is present to avoid duplication — the full
completion-flip arrives in chunk 5.

Refs docs/streaming-inline/PLAN.md chunk 2.
```

## Deferrals

(append-only)
