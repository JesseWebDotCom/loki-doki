# LokiDoki — Master Specification

Mac + Raspberry Pi 5 (CPU & Hailo-10H) — Revised March 2026

---

# What LokiDoki Is

A self-hosted, privacy-first personal AI platform running entirely on your own hardware.

- **Multi-user identity** — users, people, relationships, and preferences are modeled explicitly instead of being collapsed into one table
- **Presence awareness** — face recognition and voice ID detect who is in the room; AI adapts automatically
- **Animated personas** — custom animated characters with lip sync, per-user preferences, split-screen support
- **Distributed hardware** — Mac as master, Pi devices as clients; each node works standalone
- **Home automation** — controls Home Assistant via natural language
- **Fully private** — no cloud LLM, no subscription, no data leaving your network

---

# Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI (control plane, internal API, serves React bundle) |
| Frontend | React + Vite + Tailwind + shadcn/ui + Lucide |
| Database | SQLite (users, people, identity bindings, memory, settings, sync queue) |
| Auth | FastAPI + JWT (local, no external dependency) |
| LLM chat (mac/pi_cpu) | Qwen via Ollama — non-thinking (fast) + thinking (reasoning) modes |
| LLM chat (pi_hailo) | Qwen via hailo-ollama (port 8000, Ollama-compatible API) |
| Function model | Gemma ~270M (function-calling fine-tune) via Ollama — tool execution only |
| STT | Provider-swappable: `faster-whisper` (default) or `whisper.cpp` — CPU only, all profiles |
| TTS | Piper medium model on CPU — all profiles |
| Wake word | openWakeWord on CPU — all profiles |
| Bootstrap UI | Plain HTML/CSS/JS (no framework) |

---

# Architecture (Do Not Change)

- **Three-repo split** — core / plugins / personas
- **FastAPI** for control plane, internal master API, and serving the React frontend
- **React SPA** for the main assistant UI (chat, settings, persona, admin) — React + Vite + Tailwind + shadcn/ui
- **Orchestrator + classifier pattern** — avoids sending every request to a heavy LLM
- **Profile-based config** (`mac` / `pi_cpu` / `pi_hailo`) — single codebase, no forks
- **Personas as content packages** — not plugins, not code
- **SQLite-first** — local persistence with async replication
- **Own user system** — FastAPI + JWT + SQLite `users` table; user IDs are stable and local
- **People identity layer** — people records, optional user links, face/voice bindings, and relationship graph
- **Phase gate model** — stop and confirm before advancing

---

# Platform Targets

## mac (Primary Development Target)

Develop and validate everything here first. Only push to Pi once Mac passes.

- LLM: Qwen via Ollama — non-thinking and thinking modes
- Function model: Gemma (~270M) via Ollama
- Vision analysis: CPU via Ollama (llava or similar)
- Real-time object detection: YOLO11s
- Real-time face detection: `yolov5s_personface.onnx` via onnxruntime with CoreML execution provider preferred
- Face recognition: ArcFace-compatible embeddings
- STT: `faster-whisper` or `whisper.cpp` (profile config, default: faster-whisper)
- TTS: Piper medium model on CPU
- Wake word: openWakeWord on CPU
- Audio: NativeMacDuplexSession (`kAudioUnitSubType_VoiceProcessingIO` for AEC)

## pi_cpu

- LLM: Qwen via Ollama (quantized, e.g., qwen2:1.5b) — non-thinking and thinking modes
- Function model: Gemma (~270M) via Ollama
- Vision analysis: CPU via Ollama (moondream or llava:7b-q4)
- Real-time object detection: YOLO11n
- Real-time face detection: SCRFD-500M
- Face recognition: ArcFace-compatible embeddings
- STT: `whisper.cpp` recommended (lower RAM) or `faster-whisper` — profile config decides
- TTS: Piper medium model on CPU
- Wake word: openWakeWord on CPU
- Audio: ALSA via PipeWire/PulseAudio AEC (PiDuplexSession)

## pi_hailo

- LLM: Qwen via hailo-ollama (qwen2.5-instruct:1.5b), REST API on port 8000
- Function model: Gemma (~270M) via Ollama on CPU (too small to benefit from Hailo)
- Vision analysis: HailoRT Python API with VLM HEF
- Real-time object detection: `yolov8m_h10.hef` preferred, YOLO11n CPU fallback when more FPS, compatibility, or concurrency pressure requires it
- Real-time face detection: `yolov5s_personface.hef`, with SCRFD-500M CPU fallback required
- Face recognition: ArcFace-compatible embeddings, with CPU fallback required on every path
- STT: CPU only — `whisper.cpp` recommended for Pi RAM constraints; `faster-whisper` supported — **NOT Hailo**
- TTS: Piper medium model on CPU — **NOT Hailo**
- Wake word: openWakeWord on CPU — **NOT Hailo**
- Audio: ALSA via PipeWire AEC (same as pi_cpu)

### pi_hailo Acceleration Policy

- On `pi_hailo`, every Hailo-eligible workload should run on Hailo when the installed runtime, drivers, userland packages, and HEF assets are on the same supported version
- Hailo-eligible workloads are: fast LLM, thinking LLM, vision analysis, object detection, and face detection
- Non-Hailo workloads remain CPU-only by design: function model, STT, TTS, wake word, and audio processing
- Never mix Hailo runtime/package versions and HEF compile versions in one LokiDoki release
- If the installed Hailo runtime stack and available HEFs do not match exactly, LokiDoki must refuse Hailo activation for that workload, surface a health warning, and fall back to CPU instead of running a mismatched stack
- The installer must prefer one matched Hailo stack version across all Pi users rather than downloading newer incompatible HEFs onto an older runtime

---

# Real-Time Detection Stack

Use one application pipeline and one data model across all profiles, but choose the best-performing backend per device tier.

## Shared Pipeline Contract

```
camera frame
  -> motion gate (MOG2 background subtractor)
  -> object detector
  -> motion gate (MOG2 background subtractor)
  -> face detector
  -> face crop
  -> InsightFace buffalo_sc embedding (onnxruntime, CPU)
  -> cosine match against flat face registry
```

- Keep one provider interface and one result schema across `mac`, `pi_cpu`, and `pi_hailo`
- Swap model size and accelerator per profile, not business logic or persistence format
- Wrap both the object detector and the face detector in a platform-agnostic motion gate; when motion is not significant, skip inference and reuse the last detector result
- Recognition runs on CPU across all profiles; only the detector backend changes per profile
- Benchmark on target hardware before promoting a heavier model to default

## Default Profile Targets

- `mac`: YOLO11s + `yolov5s_personface.onnx` (onnxruntime/CoreML) + InsightFace `buffalo_sc` embeddings via onnxruntime/CPU
- `pi_cpu`: YOLO11n + SCRFD-500M + InsightFace `buffalo_sc` embeddings via onnxruntime/CPU
- `pi_hailo`: `yolov8m_h10.hef` + `yolov5s_personface.hef` + InsightFace `buffalo_sc` embeddings via onnxruntime/CPU

## Registration Flow

- The main React UI includes a `Register a Person` page reachable from the primary navigation
- Registration supports two modes: `close_up` and `far`
- The page shows a live camera preview with face boxes, auto-captures good frames, and speaks short guidance prompts
- Good-frame gating requires all of the following:
  - face bounding box at least `80x80` pixels
  - Laplacian-variance sharpness above the configured threshold
  - estimated yaw and pitch both under `45` degrees
- Good captures are embedded with InsightFace `buffalo_sc`, averaged into one identity vector, and stored in `.lokidoki/faces.json`
- Registered people are managed from the same page with add and remove actions; no manual frame picking and no database table is required for the embedding registry

## Performance Rule

- Prefer the most accurate model that still meets interactive latency on the target device
- On `pi_hailo`, drop object detection from YOLO11s to YOLO11n if live FPS, thermal headroom, or concurrent workload pressure requires it
- Every Hailo-backed detector must have a CPU fallback in the same model family when practical
- CPU fallback is a compatibility or resilience path, not the target steady state for `pi_hailo`
- Do not ship detector HEFs that target a different HailoRT version than the installed Pi runtime stack

## Licensing Checkpoint

- Ultralytics YOLO11 is not a frictionless default from a licensing standpoint; document and honor its AGPL/commercial terms before shipping beyond local development
- Stock InsightFace pretrained models are not a blanket commercial-use default; if commercial distribution matters, replace weights or obtain rights before release

---

# Hard Rules from be-more-hailo Hardware Testing

Do not override without re-validating on physical hardware.

1. **STT always on CPU** — pushing 16kHz audio through the Hailo PCIe bus caused consistent 15s+ timeouts
2. **hailo-ollama for LLM on pi_hailo** — Ollama-compatible API on port 8000; build from source via installer if not present
3. **Blacklist hailo_pci before hailo1x_pci** — Pi ships with both drivers; old one blocks `/dev/hailo0`
4. **Two-tier fast/slow LLM** — fast path (≤15 words, no complex keywords), slow path (full LLM)
5. **Bootstrap web installer, not setup.sh** — browser UI handles all install/repair
6. **Services deferred to Phase 10** — run manually with `python run.py` during development
7. **HEF files fail gracefully** — missing HEF → CPU fallback + health panel warning, never crash
8. **Validate Hailo in Phase 2** — before any subsystem depends on it
9. **No Hailo version mixing** — runtime, drivers, userland packages, and HEFs must be version-matched or the workload stays on CPU fallback

## Current Hailo Detector Constraint

As of March 26, 2026, LokiDoki must still validate every detector HEF against the installed Pi runtime stack before activation.

- `yolov5s_personface.hef` has been hardware-validated on Hailo-10H and should be preferred for `pi_hailo` face detection when present
- `yolov8m_h10.hef` remains the preferred Hailo object detector and is managed independently of the face detector
- If a detector HEF is missing or runtime-incompatible, only that workload falls back to CPU; the other detector path must remain unaffected

---

# Bootstrap and Entry Point

## run.py

Single entry point. Zero heavy dependencies — stdlib only.

```
python run.py              # health check → open browser → start app
python run.py --reinstall  # force full installer flow
python run.py --no-browser # start app, skip browser open (Phase 10 services)
```

## Launch Behavior

1. Detect platform and profile
2. Run fast health check
3. If healthy and not first run → start main app, open browser to `localhost:7860`
4. If unhealthy or first run → open browser to `localhost:7860/setup` (installer UI)

## Installer UI (Plain HTML/CSS/JS, No Framework)

- Platform/profile auto-detection
- Dependency checklist: venv, whisper.cpp, Piper, hailo-ollama, HEF files, LLM model
- Live install progress via SSE (`GET /install/stream → text/event-stream`)
- Health status cards (green/amber/red)
- Hailo driver conflict fix (automatic on pi_hailo)
- Repair mode: re-runs checks, fixes only what is broken

---

# User System

User management, login, settings, and administration are handled by LokiDoki's own FastAPI + SQLite auth system.

- SQLite `users` table: id, username, display_name, password_hash, bio, role, settings JSON
- FastAPI issues JWT on login; all API routes require valid JWT
- User IDs are stable UUIDs and remain the auth/account boundary
- Offline login must work without network — local auth only

## People Identity System

People are not the same thing as auth users.

- `people` records represent real-world humans known to the household
- A person may optionally link to a local `user` account, but does not have to
- Face embeddings, voice prints, and future presence identifiers bind to `people`, not directly to `users`
- Relationships like parent, sibling, partner, friend, and roommate are stored between `people`
- Memory and presence systems may reference either the active `user`, the recognized `person`, or both depending on context
- Admin tooling must allow linking and unlinking users, people, face identities, and voice identities without manual DB edits

---

# Frontend (React SPA)

Built with Vite, served as static files by FastAPI.

## Stack

- **React + Vite** — standard SPA setup, `npm run build` outputs to `dist/`, FastAPI serves it
- **shadcn/ui** — pre-built accessible components; use for all UI primitives (buttons, dialogs, dropdowns, inputs, cards, sheets, tabs)
- **Tailwind** — utility classes for layout and custom styling beyond shadcn defaults
- **Lucide React** — icons, selective imports only: `import { Send, Settings } from 'lucide-react'`
- **Zustand** — lightweight global state (active user, chat history, persona state, settings)

## Key Views

- **Chat** — message list with streaming token display, file upload (image/video)
- **Settings** — user profile, voice preferences, persona selection
- **Admin** — health panel, user management, plugin config
- **Installer** — handed off from `run.py` bootstrap on first run (plain HTML, not React)

## Implementation Notes

- Use shadcn/ui components as the default for all UI — do not build custom primitives from scratch
- Installer UI remains plain HTML/CSS/JS — React is only for the main app
- Tailwind: ensure `content` paths cover `./src/**/*.{ts,tsx}` in `tailwind.config.js`
- Persona animation runtime lives in the browser (JS state machine + WebSocket), not Python
- Import Lucide icons selectively — never `import * from 'lucide-react'`
- Stream LLM tokens via SSE (`EventSource`) into the chat message component

---

# Request Path and Classifier

```
[STT] → [Router] → fast Qwen / thinking Qwen / Gemma function model → [Tools/APIs] → [TTS]
```

Full internal path:
```
input → classifier → route → subsystem / plugin / provider → response
```

## Router Design

The router is prompt-based — no training required, just prompt examples. It decides between:

- **Fast Qwen** (non-thinking mode) — casual chat, short prompts, no complex reasoning
- **Thinking Qwen** (reasoning mode) — complex tasks, multi-step reasoning, summarization
- **Gemma function model** — any request requiring tool/API execution

Gemma executes the tool, returns the result, and Qwen generates the final response.

### Future Router Hardening

The current core router may use lightweight heuristics for local development, but LokiDoki should not permanently rely on keyword patches for live-information and factual web queries.

In a later phase, replace ad hoc `web_query` heuristics with a structured retrieval layer that includes:

- a dedicated router/planner model or prompt-driven classifier for `fast` / `thinking` / `tool` / `web`
- query rewriting for unstable factual lookups like people, office holders, showtimes, and current events
- deterministic post-search extraction for high-value fact patterns before falling back to free-form summarization
- a shared evaluation set of tricky prompts, typos, and temporal queries so routing quality is measured instead of guessed

Until that phase ships, treat heuristic web-query handling as an interim compatibility layer rather than the finished architecture.

## Request Types

- `simple_query` → canned response, no LLM
- `text_chat` easy → fast Qwen (non-thinking)
- `text_chat` hard → thinking Qwen (reasoning enabled)
- `tool_call` → Gemma function model → tool execution → Qwen for final response
- `image_analysis` → image subsystem
- `video_analysis` → video subsystem
- `live_video` → live video subsystem
- `memory_query` → memory subsystem
- `home_automation` → home automation plugin
- `web_query` → web plugin
- `system_query` → system plugin

## Fast/Slow Qwen Routing

- **Fast (non-thinking)**: ≤15 words, no complex keywords, conversational → lower latency, less compute
- **Thinking (reasoning)**: longer prompts, multi-step, complex keywords → full reasoning mode

---

# Voice Subsystem

## Providers (All Profiles)

- STT: whisper.cpp on CPU. Never route to Hailo.
- TTS: Piper on CPU. Voice registry maps voice IDs to Piper model files.
- Wake word: openWakeWord on CPU.

## Barge-In (AEC-First Architecture)

AEC cancels speaker signal from mic before any speech detection code sees it.

**Mac:** NativeMacDuplexSession — `kAudioUnitSubType_VoiceProcessingIO`, Python spawns `voice_processing_helper.swift` subprocess, communicates via local TCP with newline-delimited JSON

**Pi:** PiDuplexSession — PipeWire `libpipewire-module-echo-cancel` with `webrtc.gain_control=true`. `sounddevice` input points at `echo_cancel_source`.

**Barge-in detection (both platforms):**
- Run mic frames through VAD while `is_playing() == True`
- Higher confidence threshold during playback: 4–6 consecutive frames at 30ms (~120–180ms)
- On trigger: `stop_playback()`, cancel TTS, persona → listening, start new STT

---

# Persona System

- Package contents: body/head/face assets, `persona.json`, animation config, prompt config, default voice
- Display modes: off, overlay (head), docked (body), fullscreen (face)
- Animation runtime: lightweight JS module in browser, driven by WebSocket from orchestrator
- States: idle, talking, listening, thinking, error
- Non-face personas (KITT-style) use custom state-driven animation in same runtime
- Persist across sessions: enabled state, selected persona, display mode

---

# Memory System

Memory is intentionally downstream of object detection and people identity.

## Scopes

- **Session** — current conversation only
- **Person** — per-user facts across sessions
- **Family/shared** — household-level context

## Sync Model

- Every node holds a full local SQLite copy
- Writes go local first, replicate to master asynchronously
- Offline writes queue in `memory_sync_queue`, flush on reconnect
- Conflict resolution: last-writer-wins by timestamp

---

# Master/Client Node Architecture

## Modes (Config-Controlled)

- `standalone` — all subsystems local
- `master` — all local + exposes internal API on port 7861
- `client` — delegates heavy work to master, falls back to standalone if master unreachable

## Master API (Internal, Port 7861)

All requests carry `X-LokiDoki-Secret` header. Binds to local network only.

- `POST /api/infer` — text inference
- `POST /api/vision` — image analysis
- `GET/POST /api/memory` — read/write memory
- `GET /api/users` — user list and profiles
- `POST /api/auth/token` — credentials → session token
- `GET /api/health` — node mode, providers, capability map

---

# Hailo Integration (pi_hailo Only)

- Use hailo-ollama for LLM. Build from source via installer if not present.
- Use HailoRT Python API for vision. Use VDevice sharing (`ROUND_ROBIN`) for LLM + VLM concurrency.
- Validate detector HEFs against the installed Hailo runtime version before enabling them by default.
- Treat object detection and face detection as separate Hailo providers with independent CPU fallbacks.
- At startup: detect `/dev/hailo0`, validate driver health before using any Hailo provider.
- Missing Hailo or missing HEF → CPU fallback + health panel warning, never crash.
- Blacklist `hailo_pci`:
  ```
  echo "blacklist hailo_pci" | sudo tee /etc/modprobe.d/blacklist-hailo-legacy.conf
  sudo rmmod hailo1x_pci 2>/dev/null; sudo rmmod hailo_pci 2>/dev/null
  sudo modprobe hailo1x_pci
  ```

---

# Pi Development Workflow

```
# Develop and test on Mac
python run.py

# When Mac passes, sync to Pi
./scripts/sync_to_pi.sh

# Run on Pi (logs to your terminal)
./scripts/run_on_pi.sh

# Force reinstall on Pi
ssh pi@lokidoki.local "cd ~/loki-doki && python run.py --reinstall"
```

Never manually copy files. Never use VNC for development. Never develop features directly on Pi.

---

# File Structure

```
run.py
app/
  main.py
  config.py
  orchestrator.py
  classifier.py
  bootstrap/
    server.py             # stdlib only, zero deps
    installer.py
    health.py
    static/               # plain HTML/CSS/JS
  ui/                     # React SPA (Vite output served by FastAPI)
  platform/
    mac/audio.py
    pi/audio.py
  subsystems/
    text/  image/  video/  live_video/  voice/  memory/  persona/
  providers/
  settings/
scripts/
  sync_to_pi.sh
  run_on_pi.sh
  pi_log.sh
.pi.env.example
```

---

# Reference Projects

- **be-more-hailo** (moorew) — Pi + Hailo setup, STT-on-CPU decision, hailo-ollama, systemd, kiosk mode
- **hailo-rpi5-examples** (hailo-ai) — vision pipelines, face recognition, GStreamer
- **hailo-apps** (hailo-ai) — GenAI voice-to-action, parallel app patterns, VLM chat
- Hailo Community Forum — driver issues, hailo_pci conflict fixes
- Raspberry Pi AI docs — hailo-ollama install, model list, API usage

---

# Success Criteria

- Same code runs on Mac and Pi — profile config switches behavior, no code forks
- All features accessible via browser
- No cloud LLM, no subscription, no data leaving the network
- Animated persona renders in all modes and persists
- Full local voice loop: wake word → STT → LLM → TTS → persona
- Barge-in works without self-disruption on both platforms
- Plugins are isolated and optional
- Object detection works locally with profile-driven providers
- Face detection and recognition attach to explicit people records
- Voice matching attaches to people records and can be linked to user accounts when appropriate
- Memory recalls context across sessions, scoped per user
- User login works — each account has its own profile, settings, and optional linked person record
- Relationships injected into LLM context
- Face recognition identifies enrolled people through `buffalo_sc` embeddings matched against `.lokidoki/faces.json` and may map them to linked user accounts
- Persona switches automatically on presence detection
- Mac master and Pi client mode work with graceful standalone fallback
- Setup requires no manual terminal steps after git clone + python run.py

---

# Build Order

The planned implementation order is:

1. Voice subsystem
2. Object detection
3. Face detection + people identity
4. Memory subsystem
5. Persona system
6. Plugin system + master/client node
7. Home Assistant + presence automation
8. Pi hardening + services + polish
