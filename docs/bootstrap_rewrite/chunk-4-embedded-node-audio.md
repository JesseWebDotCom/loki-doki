# Chunk 4 — Embedded Node + frontend + CPU audio subsystems

## Goal

Move `npm ci` + `vite build` into the wizard. Embed node.js so users don't need it installed. Also install the CPU-only audio subsystems (Piper TTS, Whisper STT, openWakeWord) — these are the same across every profile per [CLAUDE.md:28-30](../../CLAUDE.md#L28-L30).

By the end of this chunk: runtimes + all audio are wired. Only LLM engines (chunk 5), vision (chunk 6), and Hailo (chunk 7) remain stubbed.

## Files

- `lokidoki/bootstrap/versions.py` — add NODE, PIPER, PIPER_VOICES, WHISPER entries.
- `lokidoki/bootstrap/preflight/node_runtime.py` — `ensure_node(ctx)`.
- `lokidoki/bootstrap/preflight/frontend.py` — `install_frontend_deps(ctx)`, `build_frontend(ctx)`.
- `lokidoki/bootstrap/preflight/piper_runtime.py` — `ensure_piper(ctx)`, `ensure_tts_voice(ctx, voice_id)`.
- `lokidoki/bootstrap/preflight/whisper_runtime.py` — `ensure_whisper_model(ctx, model_name)`.
- `lokidoki/bootstrap/preflight/wake_word.py` — `ensure_wake_word(ctx, engine)`.
- `lokidoki/bootstrap/steps.py` — wire real `run()`s for `embed-node`, `install-frontend-deps`, `build-frontend`, `install-piper`, `install-whisper`, `install-wake-word`.
- `run.sh` — remove `build_frontend` / `needs_rebuild` logic (already partially removed in chunk 3; ensure no trace remains).
- `tests/unit/bootstrap/test_preflight_node.py`
- `tests/unit/bootstrap/test_preflight_piper.py`
- `tests/unit/bootstrap/test_preflight_whisper.py`
- `tests/unit/bootstrap/test_frontend_skip.py`

## Actions

1. **Extend `versions.py`**:
   ```python
   NODE = {
       "version": "20.18.0",
       "artifacts": {
           ("darwin", "arm64"):   ("node-v20.18.0-darwin-arm64.tar.gz", "<sha256>"),
           ("windows","x86_64"):  ("node-v20.18.0-win-x64.zip",          "<sha256>"),
           ("linux",  "aarch64"): ("node-v20.18.0-linux-arm64.tar.xz",   "<sha256>"),
           ("linux",  "x86_64"):  ("node-v20.18.0-linux-x64.tar.xz",     "<sha256>"),
       },
       "url_template": "https://nodejs.org/dist/v{version}/{filename}",
   }
   PIPER = {
       "version": "1.2.0",
       "artifacts": {
           ("darwin", "arm64"):  ("piper_macos_aarch64.tar.gz", "<sha256>"),
           ("windows","x86_64"): ("piper_windows_amd64.zip",    "<sha256>"),
           ("linux",  "aarch64"):("piper_linux_aarch64.tar.gz", "<sha256>"),
           ("linux",  "x86_64"): ("piper_linux_x86_64.tar.gz",  "<sha256>"),
       },
       "url_template": "https://github.com/rhasspy/piper/releases/download/v{version}/{filename}",
   }
   PIPER_VOICES = {
       # voice_id → {onnx: (url, sha256), config: (url, sha256)}
       "en_US-lessac-high":   {...},
       "en_US-lessac-medium": {...},
   }
   WHISPER = {
       # model_name (matches PLATFORM_MODELS.stt_model) → (url, sha256)
       "faster-whisper small.en": ("<hf-url>", "<sha256>"),
       "whisper.cpp base.en":     ("<ggml-url>", "<sha256>"),
   }
   ```

2. **`ensure_node(ctx)`**:
   - If `ctx.binary_path("node") --version` matches `NODE["version"]`, skip.
   - Else download, extract to `.lokidoki/node/`. Tar layout on unix is `node-v20.18.0-<os>-<arch>/bin/node`; flatten one level so `.lokidoki/node/bin/` is the direct child. Windows zip extracts to `.lokidoki/node/` with `node.exe`, `npm.cmd`, `npx.cmd` at the top (no `bin/`); windows path handling is the chunk-8 concern but the layout decision happens here.

3. **`install_frontend_deps(ctx)`** / **`build_frontend(ctx)`**:
   - Cmds: `npm ci` then `npm run build` in `frontend/`.
   - Use `ctx.augmented_env()` so `.lokidoki/node/bin` is on PATH.
   - Skip-if-current logic (ported from current `run.sh`):
     - `install_frontend_deps` skips when `frontend/node_modules/.package-lock.json` hash == `frontend/package-lock.json` hash.
     - `build_frontend` skips when no file under `frontend/src/` is newer than `frontend/dist/index.html`.
   - On skip emit `StepDone(duration_s=0)` with a log line "already current".

4. **`ensure_piper(ctx)`**:
   - Download + extract to `.lokidoki/piper/`. Binary at `.lokidoki/piper/piper` (unix) or `.lokidoki/piper/piper.exe` (windows).
   - CPU-only on every profile — same code path for all five.

5. **`ensure_tts_voice(ctx, voice_id)`**:
   - `voice_id` comes from `PLATFORM_MODELS[profile]["tts_voice"]`.
   - Download onnx + config from `PIPER_VOICES[voice_id]` to `.lokidoki/piper/voices/`. Verify both sha256.

6. **`ensure_whisper_model(ctx, model_name)`**:
   - For `"faster-whisper small.en"`: no explicit download — `faster_whisper` lazily fetches on first use. This step warms the cache by instantiating `WhisperModel("small.en")` in a subprocess so the HF cache seed happens inside the wizard (with `HF_HOME=.lokidoki/huggingface`).
   - For `"whisper.cpp base.en"`: download the GGML weights to `.lokidoki/whisper/`. Verify sha256.

7. **`ensure_wake_word(ctx, engine)`**:
   - Current `engine` is always `"openWakeWord"`. Installed as a Python package via `uv sync` in chunk 3. This step warms the default model by loading `openwakeword.Model()` once in a subprocess and logging the time.

8. **Step wiring** in `steps.py`:
   - `embed-node` → `ensure_node`.
   - `install-frontend-deps` → `install_frontend_deps`.
   - `build-frontend` → `build_frontend`.
   - `install-piper` → `ensure_piper` + `ensure_tts_voice(profile.tts_voice)`.
   - `install-whisper` → `ensure_whisper_model(profile.stt_model)`.
   - `install-wake-word` → `ensure_wake_word(profile.wake_word)`.
   
   On `pi_cpu` + `pi_hailo`, mark `install-whisper` and `install-wake-word` `can_skip=True` so tight-storage setups can defer. On mac/win/linux they are required.

9. **`run.sh`** — confirm no frontend-build code remains from the old script. Only the interpreter probe from chunk 3.

10. **Tests** — use a local HTTP fixture serving fake tarballs to `StepContext.download`:
    - `test_preflight_node.py`: `.lokidoki/node/bin/node` present after run.
    - `test_preflight_piper.py`: both voices resolvable from `PIPER_VOICES`.
    - `test_preflight_whisper.py`: `"whisper.cpp base.en"` downloads; `"faster-whisper small.en"` does not.
    - `test_frontend_skip.py`: with current `dist/` and no source changes, `build_frontend` emits `StepDone(duration_s=0)` and does not spawn a subprocess.

## Verify

```bash
uv run pytest tests/unit/bootstrap/ -x && \
rm -rf .lokidoki/node .lokidoki/piper .lokidoki/whisper frontend/node_modules frontend/dist && \
./run.sh &
RUN_PID=$!
for i in $(seq 1 600); do curl -sf http://127.0.0.1:8000/api/health && break; sleep 1; done
test -x .lokidoki/node/bin/node && \
test -f frontend/dist/index.html && \
test -x .lokidoki/piper/piper && \
ls .lokidoki/piper/voices/*.onnx >/dev/null && \
kill $RUN_PID
```

## Commit message

```
feat(bootstrap): embedded node + in-wizard frontend build + CPU audio stack

Move npm ci + vite build into the wizard pipeline. First run
downloads node 20 into .lokidoki/node/ and runs the frontend build
as visible steps. Keeps the current "skip if dist/ is current" check
but in Python instead of shell.

Add the CPU-only audio installers required on every profile per
CLAUDE.md: Piper TTS binary + per-profile voice (en_US-lessac-high
on mac/win/linux, medium on pi), faster-whisper / whisper.cpp
weights for STT, openWakeWord warm-up. These stream through the
same StepContext.run_streamed helper so every subprocess line
reaches the wizard.

run.sh sheds its build_frontend / needs_rebuild block — all build
logic now lives in Python.

Refs docs/bootstrap_rewrite/PLAN.md chunk 4.
```

## Deferrals

*(empty)*
