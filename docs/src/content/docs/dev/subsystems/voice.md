---
title: Voice System
description: Kokoro TTS, Whisper STT, OpenWakeWord, and the hands-free FSM.
sidebar:
  order: 3
---

import { Aside } from '@astrojs/starlight/components';

## Overview

The voice system is split across two processes:
- **Voice sidecar** (`backend/scripts/voice-server.ts`), Kokoro TTS + Whisper STT, runs as a Bun subprocess
- **OpenWakeWord**: ONNX WASM, runs entirely in-browser via `onnxruntime-web`

No Python. No prebuilt binaries. Models auto-download at first use.

---

## TTS, Kokoro-82M

**Engine:** `kokoro-js` + `@huggingface/transformers` on `onnxruntime-wasm`

**Streaming contract:** `POST /api/tts/stream` emits one NDJSON PCM payload per sentence. The browser's `tts-playback-scheduler` plays each chunk as it lands. Never batch the whole reply, the v2 lesson was that batching causes the first word to be silent for several seconds.

**Voice resolution** (companion → user → app default):
1. `characters.ttsVoice` (qualified `engine:voice_id`)
2. User's default voice preference
3. App-wide default

**Kokoro voice picker and preview** are available in Admin → Companions for admin browsers.

---

## STT, Whisper

**Engine:** `@xenova/transformers` (transformers.js) on `onnxruntime-wasm`

Runs in the voice sidecar. The browser sends raw audio; the sidecar returns a transcript string. The transcript is then sent to the chat pipeline as a normal message.

---

## Wakeword, OpenWakeWord

**Engine:** ONNX model, loaded in-browser via `onnxruntime-web`

Models download at runtime from `/api/voice/wakeword/*` (served from `data/voice/wakewords/`). The detector runs entirely in the browser, no roundtrip to the server until a wakeword is detected.

---

## Hands-Free FSM

```
idle
  → wakeword detected → listening (STT active)
  → transcript received → processing (chat pipeline)
  → response streaming → speaking (TTS playback)
  → playback complete → idle
```

Interrupt: saying the wakeword during TTS playback cancels playback and re-enters listening.

---

## Voice Sidecar, Bun WS Gotcha

<Aside type="caution">
Bun's WebSocket export has a known gotcha: always import `WebSocketServer` from `ws` (not Bun's built-in) in the voice sidecar, or the WS connection will silently fail to broadcast to all connected clients.
</Aside>

---

## Install Components

Voice is wired into the Features/boot system as two components:
- **`voice-core`**, Kokoro + Whisper models
- **`wakeword-core`**, OpenWakeWord ONNX model download catalog

Both appear in the boot screen with inline SSE progress during download.

---

## Per-Companion Voice

Each companion can have a dedicated voice set in the companion studio (`characters.ttsVoice`). The voice resolver falls back through the chain: companion → user default → app default. This means companions can have distinct voices without requiring per-user configuration.
