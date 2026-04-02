# LokiDoki — Reference Details

This file is **not loaded automatically**. Agents read it on demand when working on hardware integration, voice, memory, or phase planning. Do not include in default context.

---

# Model Architecture

## Model Roles

| Model | Role | Notes |
|---|---|---|
| Qwen (non-thinking) | Fast chat, casual queries | Lower latency, less compute |
| Qwen (thinking) | Complex reasoning, multi-step tasks | Reasoning mode enabled |
| Gemma ~270M | Tool/function execution only | Fine-tuned on custom functions |

## Router (Prompt-Based, No Training)

The router is a lightweight prompt classifier — a small set of examples in the system prompt is enough. It outputs one of: `fast`, `thinking`, `tool`.

```python
ROUTER_SYSTEM_PROMPT = """
Classify the user's request into one of: fast, thinking, tool.

fast: casual chat, greetings, simple questions, short prompts
thinking: complex reasoning, multi-step tasks, summarization, analysis
tool: weather, stocks, network scan, home control, calendar, web search

Examples:
"what's up" → fast
"explain quantum entanglement" → thinking
"what's the weather in London" → tool
"turn off the kitchen lights" → tool
"write a haiku" → fast
"compare these two approaches and recommend one" → thinking

Respond with only the label.
"""
```

## Gemma Function Model Flow

1. Router classifies as `tool`
2. Gemma receives the user message + available tool schemas
3. Gemma outputs a structured function call
4. Tool executes, returns result
5. Result passed to Qwen (fast mode) for natural language response

Gemma handles **only** the structured function-call step — it never generates the final user-facing response.

---



## Driver Setup (pi_hailo)

```bash
echo "blacklist hailo_pci" | sudo tee /etc/modprobe.d/blacklist-hailo-legacy.conf
sudo rmmod hailo1x_pci 2>/dev/null; sudo rmmod hailo_pci 2>/dev/null
sudo modprobe hailo1x_pci
ls /dev/hailo0  # must exist
```

## hailo-ollama

- Build from source via installer if not present (follow be-more-hailo `setup.sh` logic)
- Ollama-compatible REST API on port 8000
- Model: `qwen2.5-instruct:1.5b` (or `qwen2:1.5b`)
- Endpoint: `POST http://localhost:8000/api/chat`
- Text subsystem provider just points `base_url` at port 8000

## VDevice Sharing (LLM + Vision Concurrency)

Both processes share the Hailo-10H via VDevice group:

```python
from hailo_platform import VDevice, VDeviceParams, HailoSchedulingAlgorithm
params = VDeviceParams()
params.scheduling_algorithm = HailoSchedulingAlgorithm.ROUND_ROBIN
vdevice = VDevice.create(params)  # each process does this independently
```

## HEF File Handling

Every Hailo provider must at startup:
1. Check for its required HEF file
2. Fall back to CPU provider if missing
3. Surface degraded status in the web UI health panel
4. Log exactly which HEFs are present and which are missing

---

# Voice Subsystem Details

## STT Provider (Swappable — Decide After Testing)

STT is provider-swappable via profile config. No code changes needed to switch.

```python
# config.py — profile-driven STT selection
stt_provider: str = "faster_whisper"  # or "whisper_cpp"
stt_model: str = "base.en"            # or "tiny.en" on Pi
```

**`faster-whisper`** (default on mac):
- Python-native, easier install
- ~1.5s latency on typical hardware
- Higher RAM usage

**`whisper.cpp`** (recommended on Pi):
- Lower RAM, better for Pi constraints
- Requires compiled binary
- Comparable accuracy

Both providers must implement the same `STTProvider` interface:
```python
class STTProvider:
    async def transcribe(self, audio: bytes, sample_rate: int = 16000) -> str: ...
    def is_available(self) -> bool: ...
```

STT **never** routes to Hailo on any profile — CPU only, always.

- Uses `kAudioUnitSubType_VoiceProcessingIO` (Apple's built-in AEC)
- `kAUVoiceIOProperty_BypassVoiceProcessing = 0` (AEC fully active)
- Python spawns `voice_processing_helper.swift` subprocess
- Communication: local TCP socket, newline-delimited JSON
- Mic frames: `{"type": "mic", "data": "<base64 float32 PCM>"}`
- Playback: `{"type": "play_wav", "data": "<base64 WAV>"}`

## Pi: PiDuplexSession

```bash
sudo apt install -y pipewire-audio pipewire-pulse wireplumber
mkdir -p ~/.config/pipewire/pipewire.conf.d
# Create 99-echo-cancel.conf with libpipewire-module-echo-cancel
# aec.args: webrtc.gain_control=true, extended_filter=true, delay_agnostic=true
systemctl --user restart pipewire wireplumber
```

`sounddevice` input device points at `echo_cancel_source`. All AEC happens inside PipeWire before Python sees audio.

## Barge-In Detection

- While `is_playing() == True`: run mic frames through VAD (webrtcvad or Silero VAD)
- Higher threshold during playback: `barge_in_vad_threshold = 0.7–0.85` (vs normal 0.5)
- Require 4–6 consecutive positive frames at 30ms (~120–180ms sustained speech)
- `barge_in_cooldown_ms = 300–500ms` to prevent double-trigger
- On trigger: `stop_playback()`, cancel TTS, persona → listening, start new STT

---

# Persona Package Format

```
personas/<persona_id>/
  persona.json           # id, name, display_name, default_voice, default_mode
  prompt.<lang>.txt      # system prompt / style config
  animation.json         # state machine config
  body.*                 # docked mode asset
  head.*                 # overlay mode asset
  face.*                 # fullscreen mode asset
```

Display mode → asset mapping:
- `overlay` → head
- `docked` → body
- `fullscreen` → face

Animation states (minimum): `idle`, `talking`, `listening`, `thinking`, `error`

State machine driven by WebSocket messages from orchestrator. Runtime is a JS module in the browser — not Python-side, so animation stays smooth during inference.

---

# Memory Schema

```sql
-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,         -- UUID
  username TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT,
  bio TEXT,
  relationships TEXT,          -- JSON: {"mom": "<user_id>", "partner": "<user_id>"}
  face_embedding BLOB,
  voice_embedding BLOB,
  created_at TIMESTAMP
);

-- Session memory (current conversation)
CREATE TABLE session_memory (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  user_id TEXT,
  key TEXT,
  value TEXT,
  created_at TIMESTAMP
);

-- Person memory (cross-session facts per user)
CREATE TABLE person_memory (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  key TEXT,
  value TEXT,
  updated_at TIMESTAMP
);

-- Family/shared memory
CREATE TABLE family_memory (
  id INTEGER PRIMARY KEY,
  key TEXT,
  value TEXT,
  updated_at TIMESTAMP
);

-- Offline write queue
CREATE TABLE memory_sync_queue (
  id INTEGER PRIMARY KEY,
  node_id TEXT,
  table_name TEXT,
  record_id TEXT,
  payload TEXT,          -- JSON
  created_at TIMESTAMP,
  synced_at TIMESTAMP    -- NULL until flushed
);
```

WAL mode recommended on Pi: `PRAGMA journal_mode=WAL;`

---

# Master API (Internal, Port 7861)

All requests require `X-LokiDoki-Secret` header. Server binds to local network interface only.

```
POST /api/infer          body: {user_id, prompt, context}  → {response, tokens}
POST /api/vision         body: {user_id, image_b64}         → {description}
GET  /api/memory         query: user_id, scope, key         → {value}
POST /api/memory         body: {user_id, scope, key, value} → {ok}
GET  /api/users                                             → [{id, display_name, bio}]
POST /api/auth/token     body: {username, password}         → {token, expires_at}
GET  /api/health                                            → {mode, providers, capabilities}
```

---

# All Phase Gate Checklists

## Phase 2 — Profile System + Hailo Spike

- [ ] Profile switching changes provider selection with no code changes
- [ ] Hailo LLM inference returns a response on pi_hailo hardware
- [ ] Hailo vision inference processes a test image on pi_hailo hardware
- [ ] Graceful fallback when Hailo is absent

## Phase 3 — Text Subsystem

- [ ] Sending a chat message returns a real LLM response
- [ ] Short prompts route to fast model
- [ ] Long/complex prompts route to full LLM
- [ ] Switching profile changes LLM provider

## Phase 4 — Media Subsystems

- [ ] Uploaded image returns a description from the vision model
- [ ] Uploaded video returns analysis of sampled frames
- [ ] Live camera feed previews in the web UI

## Phase 5 — Voice Subsystem

- [ ] TTS works and drives persona lip sync animation
- [ ] Wake word → STT transcribes → LLM responds → TTS speaks → persona animates
- [ ] Voice registry persists and loads correctly
- [ ] Barge-in detected and handled cleanly

## Phase 6 — Memory Subsystem

- [ ] Mentions in one session are recalled in a later session
- [ ] Person-specific facts are stored and retrieved correctly
- [ ] Memory does not bleed between different person scopes

## Phase 7 — Persona System

- [ ] Persona renders in all three display modes
- [ ] Display mode and selected persona persist across browser refresh
- [ ] Animation transitions through all states (idle, talking, listening, thinking, error)
- [ ] Non-face persona works in the animation runtime

## Phase 8 — Plugin System + Master/Client Node

- [ ] Plugins load and register without error
- [ ] Disabling a plugin removes it from routing cleanly
- [ ] Classifier routes a home automation request to the plugin
- [ ] Heuristic `web_query` patches are replaced by a structured router/planner + query rewriting layer for live factual lookups
- [ ] Client node delegates to master and falls back gracefully

## Phase 9 — Home Assistant + Presence

- [ ] "Turn on the kitchen lights" controls the correct HA entity
- [ ] "What is the temperature in the living room?" returns correct sensor value
- [ ] Plugin handles HA being offline gracefully
- [ ] Enrolled user detected from camera; persona switches automatically

## Phase 10 — Pi Hardening + Services + Polish

- [ ] Same codebase runs on Mac, pi_cpu, and pi_hailo with no code changes
- [ ] Pi auto-starts on boot via systemd after "Install as system service" is clicked
- [ ] `python run.py --reinstall` forces full reinstall cleanly on all platforms
- [ ] Pi setup requires no manual terminal steps after git clone + python run.py
- [ ] All success criteria from spec.md are met
