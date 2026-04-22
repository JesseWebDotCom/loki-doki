# Voice Streaming Design

## Goal And Scope

Streaming voice means LokiDoki starts speaking the response while the summary block is still streaming onto the screen. The visual summary remains the source of truth; voice follows it sentence-by-sentence or clause-by-clause with a small bounded lead.

In scope:
- Summary-block speech from streamed `block_patch` deltas
- Per-utterance Piper synthesis over the existing local TTS route
- Frontend chunking, queueing, pacing, barge-in, and fallback behavior
- Coexistence with existing status-phrase speech

Out of scope:
- Wake-word changes
- STT changes
- Voice cloning
- Multilingual voice selection
- Prosody emotion tuning

## Data Flow

```text
decomposition
  -> synthesis
  -> block_patch(summary, delta)
  -> sentence chunker
  -> TTS queue
  -> Piper synth
  -> ndjson PCM frames
  -> playback gate
  -> speakers

summary block renderer
  -> visual typewriter
  -> visualCursorChars
  -> playback gate
```

The visual and audio paths run in parallel. The pacing gate is the coupling point: it lets audio stay at most one utterance ahead of the typed summary.

## Sentence chunker contract

### Input

- Append-only summary-block string deltas from `block_patch`
- No random access edits
- Markdown-rich text is allowed

### Output

- Emits a closed utterance when it sees `.`, `!`, or `?` followed by whitespace or confirmed end-of-stream
- Emits a clause utterance on the last `,` or `;` when the pending buffer exceeds 120 characters
- Returns:
  - `text`: original emitted slice
  - `spokenText`: emitted slice with markdown/citation cleanup applied
  - `index`: monotonically increasing utterance index

### Speech cleanup

- Strip citation markers like `[src:N]` and `[N]`
- Strip markdown emphasis markers, headings, list bullets, and backticks while keeping inner text
- Suppress fenced code blocks entirely from speech output
- Do not speak citation syntax or formatting tokens

## Piper Streaming Contract

- Endpoint: `POST /api/v1/audio/tts/stream`
- Request body:
  - `text: string`
  - `voice: string`
  - `utterance_id: string`
- Response: newline-delimited JSON using the existing `VoiceStreamer` payload shape, extended with:
  - `utterance_id: string`
  - `final: bool`

Example chunk:

```json
{"audio_base64":"...","sample_rate":22050,"phonemes":["AA"],"samples_per_phoneme":1200,"text":"Hello world.","utterance_id":"utt-1","final":false}
```

The last chunk for a request sets `final: true`. Frontend PCM decoding stays unchanged. There is one HTTP request per utterance. Piper stays CPU-only on every profile, with no Hailo path and no remote fallback.

## Pacing gate

- Playback invariant: utterance `N+1` may start no more than one utterance ahead of the visual typewriter position for utterance `N`
- The summary renderer exposes `visualCursorChars`
- The TTS controller reads `visualCursorChars` and pauses queued playback when audio would outrun the visual
- If Piper stalls, audio is allowed to fall behind the visual; the visual remains authoritative

## Barge-in semantics

Existing contract stays: `bargeIn()` cancels active speech within 50 ms.

Streaming extension:
- Cancel the currently playing utterance immediately
- Drain queued utterances that have not started
- Abort queued or in-flight Piper fetches with `AbortController`

Triggers:
- User mic activity
- Input focus
- Keypress
- Summary `block_failed`
- Explicit stop button

## Kiosk status coexistence

Status phrases keep using `speakStatus(phaseKey, phrase)` and keep the existing throttle:
- turn must already be running for at least 3 seconds
- at most one spoken phrase per phase

Rule:
- Once the first streamed summary utterance enters the TTS queue, suppress later `speakStatus` audio for that turn
- The visual status chip remains visible

If streaming voice is disabled, or no summary `block_patch` arrives within 3 seconds, status speech behaves exactly as it does today.

## Fallback rules

- If streaming voice is disabled, use chunk-16 behavior: one `tts.speak()` call at `response_done`
- If the turn is fast-lane and no `response_init` arrives, use the same completion-time fallback
- If the streaming TTS request fails mid-turn, log it, stop streamed playback, and fall back to completion-time one-shot speech
- Completion-time `tts.speak("msg-N", spoken)` becomes idempotent finalization:
  - no-op when streaming already spoke everything
  - completes the remainder when streaming only spoke part of the turn

## User Setting

Add `settings.tts.streaming_enabled: bool`.

Defaults:
- `mac`: `true`
- `pi_hailo`: `true`
- `pi_cpu`: `false`

The setting belongs in the existing settings surface. This plan does not add a dedicated new panel.

## Non-Goals

- Voice cloning
- Multilingual synthesis
- Emotion/prosody styling controls
- Streaming STT
- Audio effects, pitch shifting, or spatial audio
