---
title: Architecture Overview
description: High-level architecture of MaiPai Home, a single-server, offline-first AI home hub.
sidebar:
  order: 1
---

## Overview

MaiPai Home is a **single-server, multi-user home application**. All AI processing runs locally, no data leaves the home network. The entire stack starts from one `run.sh` script.

---

## Process Model

| Process | Technology | Role |
|---|---|---|
| Backend | Bun + Hono | HTTP API, SSE streaming, SQLite. Listens on `PORT` (default `3000`) |
| Frontend | Vite + React 18 | SPA (served by backend from `frontend/dist` in prod) |
| LLM inference | Ollama | Chat, routing, embeddings, vision (proxied) |
| Image generation | ComfyUI (Python, headless) | SDXL via workflow JSON; spawned as a sidecar |
| Voice sidecar | Node worker + kokoro-js + `@huggingface/transformers` | Kokoro-82M TTS + Whisper STT, both in-process |
| Wakeword | ONNX WASM | OpenWakeWord via `onnxruntime-web`, runs in-browser, no sidecar |

The backend manages several sidecars: ComfyUI (image gen), the voice server (TTS/STT), `kiwix-serve` (offline library), and GraphHopper (map routing). They are spawned lazily at boot when their components are installed, and stopped on `SIGTERM`. Ollama runs as its own service and is reached over HTTP/TCP.

---

## Data Flow

### Chat request (SSE)

```
Browser
  → POST /api/chat/stream
  → requireAuth middleware (HttpOnly `session` cookie)
  → Load prefs + companion (parallel DB queries)
  → Two-tier router (all-minilm embed → cosine sim → optional granite4.1:3b LLM)
  → Memory recall (cached per conversationId)
  → Build system prompt
  → ollamaChatStream (raw node:net TCP socket, noDelay: true)
  → SSE token stream → browser
```

The raw TCP socket in `backend/src/llm/ollama.ts` parses Ollama's chunked HTTP/NDJSON directly. Bun's HTTP client buffers most of the response before emitting, which would defeat per-token streaming; the socket sets `noDelay: true` to avoid delayed-ACK batching.

See [Chat & Routing](../subsystems/chat/) for detailed latency analysis.

### Image generation

```
Browser
  → POST /api/image/generate
  → requireAuth + permission check (LoRA grants, adult-content gate)
  → LLM prompt expansion (tag format, quality prefix, LoRA triggers)
  → POST ComfyUI /prompt (workflow JSON)
  → Poll /history/{id}
  → Save to generated_images table + file
  → GET /api/image/status (SSE) → browser
```

### Voice

```
Browser (OpenWakeWord, onnxruntime-web WASM)
  → wakeword detected → activate STT
  → audio → /api/stt → voice sidecar Whisper (@huggingface/transformers)
  → transcript → send to chat
  → chat response text → POST /api/tts/stream
  → Kokoro-82M TTS (voice sidecar, kokoro-js) → NDJSON PCM chunks
  → tts-playback-scheduler → Web Audio API
```

STT runs inside the Node voice sidecar via `@huggingface/transformers` (`whisper-tiny.en` by default). An external `whisper.cpp` / `whisper-server` is only used if explicitly overridden.

---

## Auth Model

- HttpOnly cookie named `session`, no JWTs in localStorage (XSS-safe). The cookie holds a random token; only its SHA-256 hash is stored in the `sessions` table
- PIN-based with **Argon2id** hashing via `Bun.password.hash()` (PIN hashes in `profile_pins`)
- Pepper via `PIN_PEPPER_SECRET` env var; falls back to a generated `security.pin_pepper` in `app_settings` if unset. The PIN is HMAC-peppered before Argon2id
- Two middlewares: `requireAuth` and `requireAdmin` (checks `user.role === 'admin'`), in `backend/src/middleware/auth.ts`. CSRF is enforced by origin validation on unsafe methods

---

## Database

**SQLite** via Bun's built-in `bun:sqlite` + Drizzle ORM (default file `data/app.db`, WAL mode). PostgreSQL is supported as an optional override via `DATABASE_URL`.

Schema is one file (`backend/src/db/schema.ts`), and an inline `runMigrations()` in `backend/src/db/index.ts` applies idempotent `CREATE` / `ALTER` statements on every boot. The generated files under `migrations/` are not the source of truth. See [Database & Schema](../database/) for the table list and migration rules.

SQLite is correct for this use case: a handful of users, single file, trivial to back up, no network required.

---

## Storage Layout

```
data/
├── app.db                    ← SQLite database (WAL)
├── images/generated/         ← ComfyUI output images
├── voice/                    ← Kokoro + Whisper models, wakewords
├── zim/                      ← ZIM archive files (kiwix-serve)
├── maps/                     ← pmtiles tiles + GraphHopper graph data
└── comfyui/                  ← ComfyUI runtime, checkpoints, LoRAs, ipadapter, onnx
```

Exact subpaths are owned by the install registry (`backend/src/lib/installRegistry.ts`) and the sidecar helpers; treat the layout above as indicative.

---

## Feature System

Features are organized as a **Group → Category → Item** hierarchy in `frontend/src/lib/features.ts` (`FEATURE_GROUPS`). Installable units are resolved against the backend install registry (`backend/src/lib/installRegistry.ts`). The boot screen streams install status and auto-repairs missing models/binaries via the `GET /api/system/boot` SSE stream; non-essentials finish later via the durable `download_jobs` queue. See [Boot & Feature System](../boot-features/).

---

## Key Design Constraints

- **All AI calls proxy through the backend**: API keys and Ollama/ComfyUI URLs never reach the browser
- **SSE for all streaming**: chat tokens, image progress, boot repair
- **React.memo required** on all components inside the message list, the SSE handler replaces the entire `messages` array on every token (O(n²) renders without it)
- **`noDelay: true`** on the Ollama TCP socket, bypasses macOS delayed-ACK (200ms batching) for per-token delivery
