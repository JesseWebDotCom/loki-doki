# Chunk 1 — Design doc: architecture, contracts, invariants

## Goal

Produce `docs/voice-streaming/DESIGN.md`. No code this chunk. Once the design is in and reviewed, subsequent chunks implement against it. Includes: sentence-chunker contract, pacing invariants, barge-in semantics, kiosk coexistence, fallback rules when streaming voice is disabled.

## Files

Touch (create):
- `docs/voice-streaming/DESIGN.md`

Read-only reference:
- `docs/lokidoki-rich-response-design.md` (especially §20 voice parity)
- Code landmarks in [`PLAN.md`](PLAN.md)

## Actions

Author `DESIGN.md` covering the sections below. Keep it tight — design doc, not a tutorial.

1. **Goal + scope** — what "streaming voice" means; what's NOT in scope (wake-word, STT, voice cloning).
2. **Data flow diagram** — text path `decomposition → synthesis → block_patch(summary, delta) → sentence chunker → TTS queue → Piper synth → audio frames → playback gate`. Visual path runs in parallel; pacing gate couples them.
3. **Sentence chunker contract** —
   - Input: append-only string deltas for the summary block (from `block_patch`).
   - Output: emits a closed "utterance" whenever a terminating punctuation boundary is observed (`. ! ?` followed by whitespace or end). Also emit on comma/semicolon if the running buffer > 120 chars (clause fallback for run-on sentences).
   - Markdown stripping: strip `[src:N]` citation markers and `**bold**` / `*italic*` / backticks before emitting (citations don't belong in speech, formatting marks don't either).
   - Exclude code fences entirely from audio.
4. **Piper streaming contract (backend)** —
   - Endpoint: `POST /api/v1/audio/tts/stream` accepts `{ text: string, voice: string, utterance_id: string }`; responds with ndjson chunks `{ pcm: base64, sample_rate: int, utterance_id, final: bool }`.
   - One HTTP call per utterance (short sentence). Piper is CPU — latency per sentence should be sub-second on mac, ~1–2s on Pi.
   - Must reuse the existing VoiceStreamer ndjson shape so the frontend decoder is unchanged.
5. **Pacing gate (frontend)** —
   - Playback invariant: utterance N+1 audio may start ≤ 1 utterance ahead of the visual typewriter position for utterance N. If visual lags, audio queue pauses.
   - Typewriter position signal: the summary block renderer exposes a `visualCursorChars` counter; the TTS controller reads it.
   - Worst-case bound: if Piper synth stalls, playback queue drains and audio falls behind the visual. Acceptable — visual is the source of truth.
6. **Barge-in semantics** —
   - Current: `bargeIn()` cancels current utterance in ≤50ms. Extension: also drain the queued-but-not-yet-played utterances, and abort any in-flight Piper HTTP request for queued utterances (AbortController).
   - Triggers: user mic activity, input focus/keypress (unchanged from chunk 16), `block_failed` on summary block (unchanged), explicit user stop button.
7. **Kiosk status coexistence** —
   - Status audio (`Warming Up / Checking Sources / Wrapping Up`) uses `speakStatus(phaseKey, phrase)` with the existing throttle.
   - Rule: once the first streamed sentence lands in the TTS queue, suppress all subsequent `speakStatus` calls for this turn. The status chip remains visible; only the audio is suppressed.
   - Conversely: if streaming voice is disabled OR no `block_patch` to summary has arrived within 3s, status audio proceeds as today.
8. **Fallback rules** —
   - Streaming voice disabled (user setting or fast-lane turn with no `response_init`): behavior = chunk 16 (single `tts.speak()` at `response_done`).
   - Piper streaming endpoint error: frontend falls back to single-call TTS at completion; log, do not crash.
   - The completion-time `tts.speak('msg-N', spoken)` call becomes **idempotent finalization**: if streaming already spoke the full utterance set, it's a no-op. If streaming spoke partially (error mid-turn), it picks up where streaming left off — implementation detail for chunk 4.
9. **User setting** — add `settings.tts.streaming_enabled: bool` (default: true on mac, true on `pi_hailo`, false on `pi_cpu` — Pi CPU synth latency may be too high for comfort; default conservative). Setting lives in the existing settings surface; no new UI in this plan (add to existing settings panel).
10. **Non-goals** —
    - Voice cloning, multilingual synthesis, emotion prosody.
    - Streaming STT (separate effort).
    - Audio effects / pitch shift / spatial audio.

## Verify

```
test -f docs/voice-streaming/DESIGN.md && \
  grep -q "Sentence chunker contract" docs/voice-streaming/DESIGN.md && \
  grep -q "Pacing gate" docs/voice-streaming/DESIGN.md && \
  grep -q "Barge-in semantics" docs/voice-streaming/DESIGN.md && \
  grep -q "Kiosk status coexistence" docs/voice-streaming/DESIGN.md && \
  grep -q "Fallback rules" docs/voice-streaming/DESIGN.md && \
  echo "OK"
```

## Commit message

```
docs(voice-streaming): design — sentence chunker, pacing, barge-in

Captures architecture, chunker contract, Piper streaming endpoint
shape, pacing gate invariants, mid-stream barge-in semantics, kiosk
status-phrase coexistence rules, and fallback-to-chunk-16 path.
Subsequent chunks implement against this doc.

Refs docs/voice-streaming/PLAN.md chunk 1.
```

## Deferrals

(append-only)
