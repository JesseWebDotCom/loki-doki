---
title: Voice System
description: Kokoro TTS, Whisper STT, OpenWakeWord, and the hands-free FSM.
sidebar:
  order: 3
---

import { Aside } from '@astrojs/starlight/components';

## Overview

Voice runs across three places, with no Python and no cloud calls:

- **Voice sidecar** (`backend/scripts/voice-server.ts`): Kokoro TTS plus Whisper STT, a small `node:http` server. It runs under **Node**, not Bun (`onnxruntime-node`'s native addon segfaults under Bun), and is spawned/managed by `backend/src/lib/voiceServer.ts`.
- **Main backend** (Bun): the chat-facing routes (`/api/tts/stream`, `/api/stt/stream`, `/api/voice/*`, `/api/admin/voice/*`) proxy to the sidecar and run the server-side STT endpointing.
- **Browser**: OpenWakeWord ONNX detection and the hands-free state machine run entirely client-side via `onnxruntime-web`.

Models auto-download from HuggingFace into `data/voice/models/` (Kokoro and Whisper) and `data/voice/wakewords/` (OpenWakeWord) on first use.

---

## TTS, Kokoro-82M

**Engine:** `kokoro-js` (Kokoro-82M v1.0 ONNX) running inside the Node voice sidecar via `@huggingface/transformers` on `onnxruntime-node` (device `cpu`). Defaults are `KOKORO_DTYPE=q4` (faster, slight quality cost) and voice `af_heart`.

The sidecar contract (`voice-server.ts`):

- `POST /synthesize` `{ text, voice, speed }` returns `audio/wav`
- `GET /voices` returns `{ voices: [{ id, name, language, gender }] }`
- `GET /health` returns `{ ok, kokoro, whisper }`

**Streaming contract:** `POST /api/tts/stream` (in `backend/src/routes/tts.ts`) splits the reply into sentences (`segmentSentences`), synthesizes them one at a time through the resolved engine, and emits **one NDJSON line per sentence**, each a `SentencePayload` (`{ sentence, sample_rate, pcm_b64, sentence_pause }`), then a final `{ done: true }`. The content type is `application/x-ndjson`. Each sentence's WAV from the sidecar is converted to base64 PCM with `wavToPcm` before it goes on the wire. The browser plays each chunk as it lands.

Never batch the whole reply: the v2 lesson was that batching makes the first word silent for several seconds. The route logs `[TTS-TIMING] first-audio` for the first sentence as the time-to-first-spoken-word floor.

Text is run through `stripForSpeech` first, so markdown and roleplay stage directions (`*sigh*`) are never spoken. `speechRate` is clamped to 0.8 to 1.3 and `sentencePause` to 0.1 to 0.8; a character's own `speechRate` overrides the request value.

**Voice resolution** (`resolveVoice` in `backend/src/lib/voice/voiceResolver.ts`), first non-empty wins:

1. Explicit `voice` in the request body
2. `characters.ttsVoice` (qualified `engine:voice_id`)
3. User default voice (currently always `null`, per-user prefs land later)
4. App-wide default (`voice.app_default_voice` setting, env `VOICE_APP_DEFAULT`, else `kokoro:af_heart`)

Voice ids are parsed by `parseVoiceId` (`engineRegistry.ts`): bare ids (`af_heart`) resolve to the default engine; qualified ids (`kokoro:af_heart`) name an engine explicitly.

**Engine registry:** `KNOWN_ENGINES` currently holds only `kokoro` (`DEFAULT_ENGINE`). `getTtsEngine` dispatches to `kokoroEngine`. The registry stays pluggable so a future cloning engine can slot in behind a new id without touching call sites.

The Kokoro voice picker and preview live in Admin under voice settings; `GET /api/admin/voice/voices` returns the bundled voice list from the sidecar.

---

## STT, Whisper

**Engine:** Whisper running in the **same Node voice sidecar** (default), exposed at `POST /inference` (raw WAV body returns `{ text }`). The sidecar loads Whisper through `@huggingface/transformers` (transformers.js v3, package `@huggingface/transformers`, **not** `@xenova/transformers`), default model `onnx-community/whisper-tiny.en`, on `onnxruntime-node`.

The backend client is `backend/src/lib/whisper.ts`. `transcribeWav` POSTs the finalized WAV to `${whisperUrl()}/inference`. `whisperUrl()` (`backend/src/lib/voice/config.ts`) resolves `voice.whisper_url` setting, then `WHISPER_URL`, and **defaults to the same voice-server URL as TTS** (`http://localhost:8091`). So out of the box, one sidecar serves both TTS and STT.

<Aside type="note">
`whisper.ts` is written so the STT endpoint can be pointed at a **separately-installed `whisper.cpp` `whisper-server`** by overriding `voice.whisper_url` / `WHISPER_URL`. That server speaks the same `POST /inference` contract. By default, though, STT is the Whisper model inside the Node voice sidecar, not an external whisper.cpp process. `transcribeWav` throws on transport/HTTP failure (rather than returning `''`) so callers can tell "STT is down" from "no speech".
</Aside>

**Server-side endpointing** (`backend/src/lib/voice/sttSession.ts`): the browser streams `f32le` 16 kHz mono PCM frames over a WebSocket; `SttSession` buffers them, runs a simple RMS VAD (onset 0.02, offset 0.012 hysteresis), and on end-of-speech (silence past `silenceTimeoutS`, default 0.7s) encodes a 16-bit WAV and calls `transcribeWav`. Partials re-transcribe the growing buffer every `partialIntervalS` (default 0.4s), since whisper has no native streaming. A 30s hard cap force-finalizes runaway noise. `isLikelySpeech` strips bracketed annotations (`[BLANK_AUDIO]`, `(typing)`, `*sighs*`, `♪ music ♪`) so keystrokes and music never become a turn.

The WebSocket route is `backend/src/routes/stt.ts` (`WS /api/stt/stream`). It speaks the v2 wire dialect: client sends a `hello` envelope then binary PCM frames; the server emits `ready` / `vad` / `partial` / `final` / `no_speech` / `error`. This route is STT only; the frontend FSM submits the final transcript through the normal chat path.

---

## Wakeword, OpenWakeWord

**Engine:** ONNX, loaded and run entirely in-browser via `onnxruntime-web`. No roundtrip to the server until a wakeword fires.

The browser pipeline (`frontend/src/lib/voice/wake-word-pipeline.ts`) runs three ONNX sessions per 80 ms / 1280-sample frame: mel spectrogram, embedding, detector, producing a scalar score in [0, 1]. Two details matter for parity with native training:

- The mel spectrogram is recomputed over a rolling ~2.2s raw-audio window (`RAW_AUDIO_BUFFER_SAMPLES = 35200`); the trailing 76 mel frames become one embedding. Computing mel per isolated chunk was the old bug that made detectors fire on any speech.
- `RAW_AUDIO_BUFFER_SAMPLES` must equal `BUF` in the trainer so train-time and run-time features match.

**Serving:** detector files download into `data/voice/wakewords/` and are served (auth-gated) by `backend/src/routes/voice.ts`: `GET /api/voice/wakeword/:file` (the `.onnx` model bytes) and `GET /api/voice/wakewords` (lists installed detectors, merged with catalog metadata, and reports `coreInstalled`). The shared `melspectrogram.onnx` and `embedding_model.onnx` are the "core" models; individual detectors are useless without them.

**Catalog and training** (`backend/src/routes/adminWakewords.ts`, admin only):

- `GET /catalog` and `POST /import` install pretrained OpenWakeWord detectors (`hey_jarvis` default, plus `alexa`, `hey_mycroft`, `hey_rhasspy`, `timer`, `weather`), pulling the core models first if missing.
- `POST /train` trains a custom detector: it synthesizes phrase samples via Kokoro, trains a logistic regression on OpenWakeWord embeddings, exports ONNX, writes a `wakeWordCatalog` row, and attaches it to a character. By default it trains across the full diverse voice set (speaker-independent); forcing one voice overfit to a single TTS timbre.
- `POST /phonetics` asks the local LLM for plain-English pronunciation variants of a phrase (degrades gracefully if Ollama is offline).
- `PATCH /:id` persists a detector's `defaultThreshold` (the live loop reads this per-model value); `DELETE /:id` removes it.

The app default wakeword is `voice.app_default_wakeword` (else `hey_jarvis`).

---

## Hands-Free FSM

The state machine lives in `frontend/src/lib/voice/handsfree-state-machine.ts` and is driven by `frontend/src/hooks/useHandsFree.ts`:

```
off
  → engage (mic + wake loop) → idle
  → wake_detected → wake-detected
  → capture_open → capturing  (STT session open, streaming frames)
  → stt_final → replying      (transcript submitted to chat; TTS plays)
  → tts_end → post-reply-listen (STT stays open ~8s for a follow-up)
  → vad_onset → capturing      (continued conversation, no wake word)
  → post_reply_timeout → idle
```

Notable behaviors in the hook:

- **Wakeword precedence:** a trained/pretrained ONNX model (`WakeWordLoop`) always wins. The free-text phrase path (`WhisperWakewordLoop`) is only a fallback when no usable model is assigned, so a leftover phrase can never shadow a trained model. The phrase loop transcribes "<phrase> <command>" in one breath and submits the command directly.
- **Barge-in:** an RMS VAD runs only while TTS is playing (`BARGE_IN_RMS_THRESHOLD = 0.07`, 10 consecutive frames). Browser `echoCancellation` removes the speaker signal first; residual leakage stays well below the threshold. Barge-in cancels playback and re-enters listening, skipping the post-TTS mute grace.
- **Continued conversation:** after a reply, the loop stays in `post-reply-listen` with an open STT session for `POST_REPLY_TIMEOUT_MS` (8s). VAD onset within that window continues without re-requiring the wake word, capped at `MAX_CONTINUATIONS` (3) so a TV or background voice can't loop forever.
- **Stop commands:** short utterances matching `stop`/`cancel`/`quiet`/`enough`/`nevermind`/`shut up`/`go away` kill TTS and return to idle.

---

## Bun WebSocket Gotcha

<Aside type="caution">
The STT WebSocket is served by the **main Bun backend**, not the voice sidecar (the sidecar is a plain `node:http` server with no WebSockets). In `backend/src/index.ts` the `websocket` handler from `createBunWebSocket()` **must** be on the default export:

```ts
const { upgradeWebSocket, websocket } = createBunWebSocket()
// ...
export default { port, fetch: app.fetch, websocket, idleTimeout: 0 }
```

If `websocket` is left off the default export, `server.upgrade` silently fails and `/api/stt/stream` never connects. `idleTimeout: 0` keeps long voice sessions alive.
</Aside>

---

## Install / Boot Components

- **Voice sidecar models:** `installVoiceModels` (`backend/src/lib/voiceServer.ts`) runs `voice-server.ts warm` under Node to download and JIT both Kokoro and Whisper (~300 MB). A `.installed` marker next to the Kokoro weights is the true "ready" signal (the config files land minutes before the ~305 MB `model_q4.onnx`, and loading a half-written file fails with "Protobuf parsing failed"). `spawnVoiceServer` runs the sidecar detached and polls `/health`; `maybeSpawnVoiceServer` reuses an already-running instance.
- **Wakeword core + detectors:** the shared mel + embedding models and the chosen detectors download into `data/voice/wakewords/` via the admin wakeword routes; a detector import silently pulls the core first if missing.

Both surface in the boot/Features system with inline SSE progress during download.

---

## Per-Companion Voice

Each companion can carry a dedicated voice (`characters.ttsVoice`, a qualified `engine:voice_id`) set in the companion studio. The resolver falls back companion to user default to app default, so companions can have distinct voices without per-user configuration. A character can also pin a trained wakeword (`characters.wakeWordModelId`) or a free-text wake phrase (`characters.wakeWordPhrase`); the model always takes precedence over the phrase.
