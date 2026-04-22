# Chunk 5 — Mid-stream barge-in

## Goal

Extend `bargeIn()` to cleanly cut streamed audio at any point: abort all in-flight Piper stream HTTP requests, stop the currently-playing audio source, drain the queue, reset the chunker state. Response time ≤ 50ms end-to-end (keep chunk 16 latency budget).

## Files

Touch:
- `frontend/src/utils/tts.ts`
- `frontend/src/utils/VoiceStreamer.ts`
- `frontend/src/utils/__tests__/ttsBargeIn.test.ts` (new or extend)

Read-only reference:
- Existing barge-in triggers in `frontend/src/pages/ChatPage.tsx` L635–640 (block_failed), L1256–1267 (input focus/keypress)

## Actions

1. In `tts.ts`, extend `bargeIn()`:
   - Abort every AbortController in the pending-stream-requests map.
   - Stop every live `AudioBufferSourceNode` and disconnect.
   - Clear the utterance queue.
   - Reset the chunker for the active turn (so a late `block_patch` doesn't re-enqueue).
   - Set a `turnCancelled: true` flag keyed by `messageKey` so a late `endStreamingTurn` becomes a no-op for the cancelled turn.
2. Verify all existing `bargeIn()` triggers still fire and still succeed — no behavior regression for chunk-16 one-shot TTS.
3. Edge case: if `bargeIn()` fires during the gap between utterance N complete and utterance N+1 fetch-start, ensure no audio from N+1 ever plays (AbortController cancels the fetch before audio scheduling).
4. Edge case: user starts typing (input focus/keypress barge-in), streaming voice cancels, user then sends a new message — the new turn's `beginStreamingTurn` resets all state; no bleed.
5. Tests in `__tests__/ttsBargeIn.test.ts`:
   - Mock fetch + AudioContext. Start a streaming turn, push deltas for 3 sentences, call `bargeIn()` while utterance 2 is playing. Assert: utterance 2 source stopped, utterance 3 fetch aborted, queue empty.
   - Barge-in during fetch gap (between utterance 1 complete and utterance 2 fetch) — utterance 2 never scheduled on AudioContext.
   - Post-barge-in, starting a new turn works cleanly.

## Verify

```
cd frontend && npx vitest run src/utils/__tests__/ttsBargeIn.test.ts && npx tsc --noEmit
```

Manual: `npm run dev`. Start a long non-fast-lane turn. Mid-stream, type a character in the input. Audio cuts within ~50ms.

## Commit message

```
feat(voice-streaming): mid-stream barge-in cuts queue + in-flight fetches

Extends bargeIn() to abort all pending Piper stream fetches via
AbortController, stop live AudioBufferSourceNodes, drain the utterance
queue, reset the chunker, and set a turn-cancelled flag so late
block_patch deltas or the terminal endStreamingTurn become no-ops.
Chunk-16 one-shot TTS barge-in path unchanged.

Refs docs/voice-streaming/PLAN.md chunk 5.
```

## Deferrals

(append-only)
