# Chunk 7 — Tests + regression suite

## Goal

Lock in the voice-streaming pipeline end-to-end. Cover: backend endpoint, chunker, queue + pacing gate, barge-in, kiosk coexistence, fallback to chunk 16. Prevent regressions against rich-response chunk 16 and streaming-inline chunks 1–6.

## Files

Touch:
- `tests/unit/test_tts_streaming.py` (extend — backend)
- `frontend/src/utils/__tests__/sentenceChunker.test.ts` (extend if needed)
- `frontend/src/utils/__tests__/ttsStreamingPipeline.test.ts` (new — integration)
- `frontend/src/utils/__tests__/ttsBargeIn.test.ts` (extend)
- `frontend/src/pages/__tests__/chatPageVoiceStreaming.test.tsx` (new)

Read-only reference:
- Chunks 1–6 of this plan.

## Actions

1. **Backend** (`test_tts_streaming.py`): extend coverage — invalid voice returns 4xx; empty text returns empty-or-single-chunk cleanly; `utterance_id` is echoed verbatim; concurrent requests don't bleed state.
2. **Pipeline integration** (`ttsStreamingPipeline.test.ts`): mock fetch + AudioContext. Simulate a full turn:
   - `beginStreamingTurn(msgKey)`
   - `pushStreamingDelta(msgKey, "The quick brown fox ")`
   - `pushStreamingDelta(msgKey, "jumps over the lazy dog. ")` → utterance 1 emitted, fetch to `/audio/tts/stream` issued
   - visualCursorChars advances through utterance 1 → utterance 1 audio plays
   - more deltas → utterances 2, 3 enqueue
   - `endStreamingTurn(msgKey, finalText)` + terminal `speak(msgKey, finalText)` → no extra synth (idempotent)
   - Assert fetch call count, audio source start order, queue state.
3. **Pacing gate** (same file): simulate visualCursor lagging behind audio queue. Assert utterance N+1 does NOT start until visualCursor crosses utterance N's end offset.
4. **Barge-in mid-stream** (`ttsBargeIn.test.ts`): extend beyond chunk 5 tests — barge-in at each pipeline stage (during fetch, during playback, during fetch-gap, after flush) and assert cleanup.
5. **Kiosk coexistence** (`ttsStreamingPipeline.test.ts`): `speakStatus` called before first utterance → speaks; `speakStatus` called after → suppressed. Fast-lane turn: `speakStatus` always speaks.
6. **Fallback** (`chatPageVoiceStreaming.test.tsx`): with `streaming_enabled: false`, simulate full turn with block_patch deltas. Assert: `pushStreamingDelta` never runs; chunk-16 single `tts.speak` fires once on `response_done`; no fetches to `/audio/tts/stream` for short utterances.
7. **Chunk 16 regression**: run chunk-16's existing test suite and confirm no failures introduced by this plan's changes.

## Verify

```
uv run pytest tests/unit/test_tts_streaming.py -v && \
  cd frontend && npx vitest run src/utils/__tests__/ src/pages/__tests__/
```

## Commit message

```
test(voice-streaming): end-to-end pipeline + regression coverage

Covers: backend endpoint edge cases, chunker → fetch → playback
integration, typewriter pacing gate, mid-stream barge-in at every
pipeline stage, kiosk status-phrase coexistence, fallback to chunk-16
single-call TTS when streaming is disabled. Prevents regressions to
the rich-response chunk-16 voice-parity contract.

Refs docs/voice-streaming/PLAN.md chunk 7.
```

## Deferrals

(append-only)
