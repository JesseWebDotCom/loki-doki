# Chunk 6 — Kiosk status-phrase coexistence

## Goal

"Warming Up / Checking Sources / Wrapping Up" status audio must not collide with streamed response audio. Rule: once the first streamed utterance is enqueued for a turn, suppress all further `speakStatus()` calls for that turn. Status chip remains visible; only audio is suppressed. If streaming voice is disabled OR no summary delta arrives within 3s, status audio proceeds as today.

## Files

Touch:
- `frontend/src/utils/tts.ts` (extend `speakStatus` gating)
- `frontend/src/pages/ChatPage.tsx` (ensure per-turn reset)

Read-only reference:
- `frontend/src/pages/ChatPage.tsx` L645–657 (existing status block_patch → `speakStatus`)
- `docs/voice-streaming/DESIGN.md` §7

## Actions

1. In `tts.ts`, add a per-turn flag `streamingAudioActive: boolean`, keyed by `messageKey`. Set `true` the first time `pushStreamingDelta` enqueues any utterance. Set `false` at turn start / after `bargeIn` / on turn cancellation.
2. `speakStatus(phaseKey, phrase)` — if `streamingAudioActive === true` for the current message key, no-op (log at `debug`). Existing throttle (≥3s gate, ≤1 per phase) unchanged otherwise.
3. In `ChatPage.tsx`, at the start of `sendChatMessage` (turn-start reset), call `ttsController.resetTurnFlags(nextMessageKey)` so the previous turn's flags don't leak.
4. Fast-lane turns (no `response_init`) never set `streamingAudioActive`, so status audio works as today.
5. When streaming is disabled by setting, `pushStreamingDelta` never runs, so `streamingAudioActive` stays false — status audio works as today.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/utils/__tests__/
```

Manual: `npm run dev`. Non-fast-lane turn: expect status audio during Warming Up, THEN the streamed response audio, NO status audio saying "Wrapping Up" on top of the response. Fast-lane turn: status audio behavior unchanged from today.

## Commit message

```
feat(voice-streaming): suppress status audio once streaming audio is live

Adds a per-turn streamingAudioActive flag so speakStatus no-ops once
the first streamed utterance is enqueued. Status chip remains visible
(visual is untouched); only audio overlap is prevented. Fast-lane and
streaming-disabled paths keep today's status-audio behavior.

Refs docs/voice-streaming/PLAN.md chunk 6.
```

## Deferrals

(append-only)
