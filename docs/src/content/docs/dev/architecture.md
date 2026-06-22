---
title: Architecture Overview
description: High-level architecture of loki-doki-v3, a single-server, offline-first AI home hub.
sidebar:
  order: 1
---

## Overview

loki-doki-v3 is a **single-server, multi-user home application**. All AI processing runs locally, no data leaves the home network. The entire stack starts from one `run.sh` script.

---

## Process Model

| Process | Technology | Role |
|---|---|---|
| Backend | Bun + Hono | HTTP API, SSE streaming, SQLite |
| Frontend | Vite + React 18 | SPA (served by backend in prod) |
| LLM inference | Ollama | Chat, routing, embeddings, vision |
| Image generation | ComfyUI (headless) | Stable Diffusion XL via workflow JSON |
| Voice sidecar | Bun + kokoro-js | Kokoro-82M TTS + Whisper STT |
| Wakeword | ONNX WASM | OpenWakeWord, runs in-browser, no sidecar needed |

---

## Data Flow

### Chat request (SSE)

```
Browser
  → POST /api/chat/stream
  → Auth middleware (HttpOnly session cookie)
  → Load prefs + companion (parallel DB queries)
  → Three-tier router (embed → cosine sim → optional granite4.1:3b LLM)
  → Memory recall (cached per conversationId, 30-min TTL)
  → Build system prompt
  → ollamaChatStream (raw TCP socket, noDelay: true)
  → SSE token stream → browser
```

See [Chat & Routing](../subsystems/chat/) for detailed latency analysis.

### Image generation

```
Browser
  → POST /api/imaging/generate
  → Auth + permission check (LoRA grants, adult content gate)
  → LLM prompt expansion (tag format, quality prefix, LoRA triggers)
  → POST ComfyUI /prompt (workflow JSON)
  → Poll /history/{id}
  → Save to generated_images table + file
  → SSE progress events → browser
```

### Voice

```
Browser (OpenWakeWord WASM)
  → wakeword detected → activate STT
  → Whisper STT (via voice sidecar WS)
  → transcript → send to chat
  → chat response text → POST /api/tts/stream
  → Kokoro TTS (voice sidecar) → NDJSON PCM chunks
  → tts-playback-scheduler → Web Audio API
```

---

## Auth Model

- HttpOnly session cookies, no JWTs in localStorage (XSS-safe)
- PIN-based with **Argon2id** hashing via `Bun.password.hash()`
- Pepper via `PIN_PEPPER_SECRET` env var (256-bit hex, never stored in DB)
- Admin vs. user role distinction

---

## Database

**SQLite** via Bun's built-in `bun:sqlite` + Drizzle ORM. PostgreSQL supported as an optional override via `DATABASE_URL`.

SQLite is correct for this use case: 2–8 users, single file, trivial to back up, no network required. See [Database & Schema](../database/) for the full table list.

---

## Storage Layout

```
data/
├── loki-doki.db              ← SQLite database
├── images/generated/         ← ComfyUI output images
├── voice/
│   ├── models/               ← Kokoro + Whisper ONNX models
│   └── wakewords/            ← OpenWakeWord ONNX models
├── zim/                      ← ZIM archive files
├── maps/
│   ├── tiles/                ← pmtiles vector tile files
│   └── routing/              ← GraphHopper graph data
└── router-index.json         ← Cached embedding index for tool routing
```

---

## Feature System

Features are organized as a **Group → Category → Item** hierarchy defined in `frontend/src/lib/features.ts`. The boot screen shows install status for each item and auto-repairs missing models/binaries via inline SSE progress. See [Boot & Feature System](../boot-features/).

---

## Key Design Constraints

- **All AI calls proxy through the backend**: API keys and Ollama/ComfyUI URLs never reach the browser
- **SSE for all streaming**: chat tokens, image progress, boot repair
- **React.memo required** on all components inside the message list, the SSE handler replaces the entire `messages` array on every token (O(n²) renders without it)
- **`noDelay: true`** on the Ollama TCP socket, bypasses macOS delayed-ACK (200ms batching) for per-token delivery
