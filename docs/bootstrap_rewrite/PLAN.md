# Bootstrap Rewrite — Execution Plan

Goal: a user with a factory-fresh arm64 Mac, Windows 11 PC, desktop Linux box, or freshly-flashed Raspberry Pi 5 clones the repo, runs one command, and watches LokiDoki install itself inside a browser wizard. No brew, no chocolatey, no apt, no `curl | sh`, no Ollama. The only prereq is "a Python interpreter exists on the system."

This is a **clean-install rewrite**. No migration from a previous LokiDoki, no stale-model cleanup, no backwards compat with the old installer. Every run either finds a valid `.lokidoki/` or starts fresh.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk, append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

---

## Status

| # | Chunk                                                                   | Status  | Commit  |
|---|-------------------------------------------------------------------------|---------|---------|
| 1 | [Profile catalog + detection](chunk-1-profile-catalog.md)               | done    | ad2672d |
| 2 | [Stdlib bootstrap server + event model](chunk-2-stdlib-server.md)       | done    | 0e2ff8a |
| 3 | [Embedded Python + uv + deps in wizard](chunk-3-embedded-python.md)     | done    | 043ff09 |
| 4 | [Embedded Node + frontend + CPU audio](chunk-4-embedded-node-audio.md)  | done    | 8b91aa3 |
| 5 | [LLM engines (MLX, llama.cpp Vulkan/CPU) + provider layer](chunk-5-llm-engines.md) | done    | PENDING |
| 6 | [Vision models per engine](chunk-6-vision.md)                           | pending |         |
| 7 | [pi_hailo runtime + graceful fallback](chunk-7-hailo.md)                | pending |         |
| 8 | [Windows support (run.bat + win branches)](chunk-8-windows.md)          | pending |         |
| 9 | [Offline bundle + README rewrite](chunk-9-offline.md)                   | pending |         |

---

## Global context (read once, applies to every chunk)

### Architecture — three layers

```
Layer 0  run.sh / run.bat           shell launcher: profile detect + interpreter probe
   │                                 any Python 3.8+ from the OS
Layer 1  lokidoki/bootstrap/server   stdlib http.server wizard + pipeline
   │                                 embedded python 3.12 + full venv
Layer 2  lokidoki.main:app           the FastAPI application (mostly unchanged)
```

- Layer 0 prints one crisp install instruction and exits if it can't find a Python. No tracebacks to the user.
- Layer 1 runs on stock Python 3.8+. Imports only stdlib — `http.server`, `urllib`, `json`, `subprocess`, `pathlib`, `threading`, `tarfile`, `zipfile`, `platform`, `hashlib`.
- Layer 2 is the existing FastAPI app running under the embedded Python 3.12 that Layer 1 installed.

### Supported profiles

| Profile | OS | Arch | Notes |
|---|---|---|---|
| `mac` | macOS 12+ | **arm64 only** | Intel Macs are not supported — launcher detects and exits. |
| `windows` | Windows 10+ | x86_64 | |
| `linux` | Desktop Linux | x86_64 | |
| `pi_cpu` | Raspberry Pi OS bookworm+ | aarch64 | Pi 5 without Hailo HAT |
| `pi_hailo` | Raspberry Pi OS bookworm+ | aarch64 | Pi 5 with Hailo HAT |

### LLM engine per profile (best-of-breed, not one-size-fits-all)

| Profile | Engine | Why |
|---|---|---|
| `mac` | **MLX** via `mlx-lm` | 30-50% faster than alternatives on Apple Silicon; Metal + unified memory |
| `windows` | **llama.cpp** (Vulkan build) | one binary covers NVIDIA/AMD/Intel GPUs at ~95% of CUDA perf; CPU fallback built in |
| `linux` | **llama.cpp** (Vulkan build) | same as windows |
| `pi_cpu` | **llama.cpp** (CPU ARM NEON) | lighter than a daemon, better NEON utilization |
| `pi_hailo` | **hailo-ollama** | mandated by [CLAUDE.md:32](../../CLAUDE.md#L32); required by Hailo HAT |

No stock Ollama anywhere. The provider layer in chunk 5 presents a unified HTTP-shaped API to Layer 2 so application code does not branch on which engine is backing a request.

### Where model names + versions live

**Model IDs** (Qwen variants, Piper voices, HEF files, vision models) — [lokidoki/core/platform.py::PLATFORM_MODELS](../../lokidoki/core/platform.py). One dict, keyed by profile, carries every model the profile needs. Fields include `llm_engine`, `llm_fast`, `llm_thinking`, `vision_model`, `object_detector_model`, `face_detector_model`, `stt_model`, `tts_voice`, `wake_word`, `image_gen_model`, `image_gen_lcm_lora`, `fast_keep_alive`, `thinking_keep_alive`.

**Tarball/binary versions** (python-build-standalone, uv, node, llama.cpp, mlx-lm, piper, hailo-ollama) — `lokidoki/bootstrap/versions.py` (new). Separate concern: these are runtime dependencies, not models.

No third location. If a future feature needs to resolve a model ID, it reads `PLATFORM_MODELS`. If it needs to download a binary, it reads `versions.py`.

### What we explicitly do NOT ship or port

- **No Ollama.** Not stock Ollama, not anywhere in the mac/win/linux/pi_cpu path. Only `hailo-ollama` on `pi_hailo` because the Hailo HAT requires it.
- **No Gemma.** The old architecture's function-model layer is not in the current codebase (orchestrator routes via classifier + skills + Qwen synthesis). Do not port `gemma4:e2b`, `gemma3:1b`, or a `function_model` field.
- **No stale-model cleanup.** We are not an upgrade installer. `.lokidoki/` is either valid or rebuilt.
- **No `MODEL_MIGRATIONS`** map. Same reason.
- **No Intel Mac support.** Launcher detects `darwin` + `x86_64` and exits with a "not supported — arm64 Mac required" message.
- **No brew / chocolatey / apt / winget / scoop.** Direct tarball/zip from upstream, SHA-256 verified.
- **No `curl | sh`.** Ever.
- **No sudo / UAC prompts.** A step that needs privileges emits `StepFailed` with a remediation string the user runs themselves.
- **No framework in the bootstrap UI.** Plain HTML/CSS/JS per [CLAUDE.md:44](../../CLAUDE.md#L44).

### Hard rules (from [CLAUDE.md](../../CLAUDE.md))

- STT / TTS / wake-word are CPU-only on every profile.
- Hailo accelerates **LLM and vision only**, on `pi_hailo` only.
- Missing Hailo hardware or HEF files must fail gracefully — fall back to `pi_cpu`, never crash.
- Blacklist `hailo_pci` before using `hailo1x_pci`.
- Three-repo split: bootstrap never installs from `loki-doki-plugins` or `loki-doki-personas`.

### Symlink note

[CLAUDE.md](../../CLAUDE.md) is a symlink to [AGENTS.md](../../AGENTS.md). **One file, one edit.** Any chunk that updates agent instructions edits `AGENTS.md` only.

### `.lokidoki/` directory layout (target)

```
.lokidoki/
  python/              embedded python-build-standalone
  uv/                  uv binary
  node/                embedded node.js
  llama.cpp/           llama-server binary (profile-specific build)
  mlx/                 mac only — mlx-lm server scripts
  hailo_ollama/        pi_hailo only
  hef/                 pi_hailo only — .hef model files
  models/
    llm/               GGUF / MLX weights (per-engine format)
    vision/            vision-model weights (per-engine)
    detectors/         ONNX or HEF detector weights
  piper/               piper binary + voices/
  whisper/             faster-whisper weights or whisper.cpp
  huggingface/         HF_HOME target for snapshot_download
  data/                sqlite + memory store + user media
  logs/                bootstrap.log, app.log, llm.log
  bootstrap_config.json
  installer_state.json
  versions.lock.json
```

Everything gitignored. `rm -rf .lokidoki/` restarts clean.

---

## NOTE (append as chunks land)

*(empty — chunks add notes here about discoveries or deferrals that affect future chunks)*
