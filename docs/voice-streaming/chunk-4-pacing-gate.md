# Chunk 4 — TTS queue + typewriter-paced playback gate

## Goal

Wire chunker (chunk 3) + Piper streaming endpoint (chunk 2) + typewriter cursor (from streaming-inline chunk 3) into a playback pipeline: each closed utterance kicks off a Piper stream request and queues PCM frames on the audio context; playback gates on the visual typewriter position so audio never races more than one utterance ahead.

## Files

Touch:
- `frontend/src/utils/tts.ts` (extend — new streaming-mode methods)
- `frontend/src/utils/VoiceStreamer.ts` (extend — per-utterance mode)
- `frontend/src/utils/ttsController.ts` (or wherever the `ttsController` facade lives — locate via `rg -n "ttsController" frontend/src`)
- `frontend/src/pages/ChatPage.tsx` (wire to `block_patch` on summary)
- `frontend/src/components/chat/blocks/SummaryBlock.tsx` (expose `visualCursorChars` signal)

Read-only reference:
- `docs/voice-streaming/DESIGN.md`
- `frontend/src/utils/sentenceChunker.ts` (chunk 3)

## Actions

1. In `tts.ts`, add `beginStreamingTurn(messageKey, options)` that creates a per-turn TTS session: a `sentenceChunker`, an utterance queue, a `visualCursor` ref, a cancel-all function.
2. Add `pushStreamingDelta(messageKey, delta)` — feeds chunker, takes any emitted utterances, and enqueues each with a pending Piper stream request (AbortController per utterance).
3. Add `endStreamingTurn(messageKey, finalText)` — calls `chunker.flush()`, enqueues any trailing utterance, and becomes idempotent with the existing `tts.speak(messageKey, ...)` terminal call:
   - If the streaming queue covered the full `finalText` (sum of utterance spoken texts ≈ finalText stripped), completion-time `tts.speak` is a no-op.
   - Else, completion-time `tts.speak` synthesizes the remaining tail via the one-shot endpoint (chunk 16 fallback) and enqueues it at the tail of the queue.
4. Playback gate: each queued utterance has `startOffset` = running sum of prior utterance durations. Before starting playback of utterance N, check `visualCursorChars >= utterance[N-1].endChar`. If not, poll (rAF) until it is.
5. `SummaryBlock.tsx`: publish a `visualCursorChars` value. The simplest path — emit on every render the length of rendered markdown text so far. Expose via a ref-passing callback or a tiny zustand/subject exposed by the TTS module.
6. In `ChatPage.tsx`: in the `isResponseEvent` branch, on `block_patch` for summary block with a `delta`, call `ttsController.pushStreamingDelta(messageKey, delta)` — but only when `streaming_enabled` setting is true AND the envelope is present (fast-lane turns skip streaming voice entirely).
7. On `response_done`, call `ttsController.endStreamingTurn(messageKey, finalText)` BEFORE the existing `tts.speak(messageKey, spoken)`. The `speak` call becomes the idempotent finalizer described in action 3.
8. Respect barge-in wiring already in place — `bargeIn()` must abort all pending Piper streams (AbortController) AND stop the audio context playback AND drain the queue. Extend `bargeIn` accordingly in chunk 5.
9. Add a user setting `settings.tts.streaming_enabled` (boolean) read from the existing settings store. Default from platform profile (mac/pi_hailo: true; pi_cpu: false). When false, this whole pipeline no-ops and chunk 16 behavior is identical to today.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/utils/__tests__/
```

Manual: `npm run dev` + backend. Non-fast-lane turn on mac. Confirm: first sentence of audio plays while the rest is still typing; audio never outpaces the typed text by more than one sentence; turn ends with audio and text finishing within ~500ms of each other.

## Commit message

```
feat(voice-streaming): queue-based streaming TTS with typewriter pacing

Wires the sentence chunker (chunk 3) to the per-utterance Piper
endpoint (chunk 2) through a queued playback gate that buffers one
utterance ahead of the visual typewriter position. Completion-time
tts.speak becomes an idempotent finalizer: no-op if streaming covered
the full text, otherwise synthesizes the tail via the one-shot
endpoint. Gated behind ``settings.tts.streaming_enabled`` with
conservative defaults per platform profile.

Refs docs/voice-streaming/PLAN.md chunk 4.
```

## Deferrals

(append-only)
