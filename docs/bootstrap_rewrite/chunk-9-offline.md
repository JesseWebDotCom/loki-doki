# Chunk 9 — Offline bundle + README rewrite

## Goal

Ship the install story. Add an offline-bundle script for air-gapped deployments. Rewrite the README install section so the only install instruction per platform is one command. Update [AGENTS.md](../../AGENTS.md) to reflect the new bootstrap architecture.

No legacy code removal in this chunk — per the plan directive, this is a clean-install design, so there's no `run.py` or FastAPI-served `/bootstrap` to remove. Those never existed in the target state.

## Files

- `scripts/build_offline_bundle.py` — pre-download every pinned artifact + HF snapshot.
- `scripts/verify_offline_bundle.py` — check bundle integrity.
- `lokidoki/bootstrap/offline.py` — on startup, seed `.lokidoki/cache/` from a sibling bundle dir.
- `lokidoki/bootstrap/__main__.py` — add `--reset`, `--skip-optional`, `--offline-bundle=<path>` flags.
- `lokidoki/bootstrap/ui/bootstrap.js` — retry-failed + skip-optional buttons.
- `README.md` — rewrite install section.
- `AGENTS.md` — add the bootstrap-architecture bullets (chunk 1 already stripped outdated model claims; this chunk adds entry-point facts).

## Actions

1. **`scripts/build_offline_bundle.py`**:
   - Args: `--profile=<one|all>`, `--output=<dir>` (default `./lokidoki-offline-bundle/`).
   - Reads `lokidoki/bootstrap/versions.py`. For every artifact in every spec (python, uv, node, llama.cpp, piper, whisper, hailo_ollama, HEF files), downloads to `<output>/cache/<filename>`. Verifies SHA-256.
   - Reads `lokidoki/core/platform.py::PLATFORM_MODELS`. For the requested profile(s), downloads HF snapshots into `<output>/huggingface/` via `huggingface_hub.snapshot_download`.
   - Writes `<output>/bundle_manifest.json` with every file's sha256 + byte size.
   - Bundle folder is what the user copies next to the repo clone on the target machine.

2. **`scripts/verify_offline_bundle.py`**:
   - Takes a bundle path; compares every file against `bundle_manifest.json`.
   - Exit 0 = usable; exit 1 = repair needed with a list of missing/corrupt files.

3. **`lokidoki/bootstrap/offline.py`**:
   - On startup, if `--offline-bundle=<path>` was passed OR a sibling `lokidoki-offline-bundle/` directory exists, symlink (unix) or copy (windows) its `cache/` contents into `.lokidoki/cache/`, and set `HF_HOME` to point at the bundle's `huggingface/` subdir.
   - Preflights already short-circuit on SHA match, so once the cache is pre-seeded the entire pipeline runs without network.

4. **`--reset` flag** in `__main__.py`:
   - Deletes `.lokidoki/` entirely after a wizard confirmation modal (plain HTML/CSS/JS per CLAUDE.md).

5. **`--skip-optional` flag** in `__main__.py`:
   - Sets a flag the pipeline checks; every step with `can_skip=True` emits `StepDone(duration_s=0)` with log "skipped (--skip-optional)".

6. **Retry button** in `bootstrap.js` — wire the "Retry" button on `step_failed` tiles to `POST /api/v1/bootstrap/retry` with `{step_id}`.

7. **Skip button** on `can_skip` tiles — visible before the step runs; click marks it to skip.

8. **README rewrite** — proposed install section:

   ```markdown
   ## Install

   ### macOS (Apple Silicon)
   \`\`\`bash
   git clone https://github.com/JesseWebDotCom/loki-doki
   cd loki-doki
   ./run.sh
   \`\`\`

   ### Linux (x86_64 desktop) and Raspberry Pi 5
   \`\`\`bash
   git clone https://github.com/JesseWebDotCom/loki-doki
   cd loki-doki
   ./run.sh
   \`\`\`

   ### Windows
   \`\`\`
   git clone https://github.com/JesseWebDotCom/loki-doki
   cd loki-doki
   run.bat
   \`\`\`

   A browser opens to the install wizard. It downloads Python, Node,
   and the right LLM engine for your platform (MLX on mac, llama.cpp
   Vulkan on Windows/Linux, llama.cpp CPU on Pi, hailo-ollama on
   Pi + Hailo HAT), plus the Qwen LLMs and vision models sized for
   your hardware. First run takes 10-30 minutes depending on network;
   subsequent runs start in seconds.

   ### Prerequisites
   - **macOS** — Apple Silicon required. Intel Macs are not supported.
     If you don't have Python, run `xcode-select --install`.
   - **Linux** — your distro's `python3` (Raspberry Pi OS ships one).
   - **Windows** — Python 3.11+ from https://python.org if not
     already installed. The launcher will prompt.

   ### Offline install
   \`\`\`
   python scripts/build_offline_bundle.py --profile=mac --output=/media/usb/lokidoki-offline-bundle
   # on the target machine:
   cp -r /media/usb/lokidoki-offline-bundle ./
   ./run.sh
   \`\`\`
   ```

9. **AGENTS.md additions** (chunk 1 removed Gemma; this chunk adds the architecture):
   - Under "Approach" or a new "Bootstrap" section, add:
     - "Entry point is `./run.sh` (mac/linux) or `run.bat` (windows). `run.py` is not the entry point."
     - "All bootstrap logic lives under `lokidoki/bootstrap/`. The install wizard is plain HTML/CSS/JS at `lokidoki/bootstrap/ui/`."
     - "Model IDs live in `lokidoki/core/platform.py::PLATFORM_MODELS`. Runtime binary versions live in `lokidoki/bootstrap/versions.py`. Do not create a third location."
     - "Intel Macs are not supported. Detection raises `UnsupportedPlatform`."
     - "LLM engines: MLX on mac, llama.cpp (Vulkan) on windows+linux, llama.cpp (CPU) on pi_cpu, hailo-ollama on pi_hailo. No stock Ollama anywhere in the codebase."
   - `CLAUDE.md` is a symlink — do not edit it directly.

10. **Final grep** — the plan's no-go list is enforced:
    ```
    rg -n '(^|[^-])ollama(?!-ollama|_ollama)' lokidoki/ run.sh run.bat
    # only hailo-ollama / hailo_ollama should match; nothing else.
    rg -n 'gemma' lokidoki/ AGENTS.md
    # should return zero.
    rg -n 'brew|chocolatey|choco|winget|scoop|apt-get|dnf install' lokidoki/ run.sh run.bat
    # should return zero (or only in comments describing what we do NOT do).
    rg -n 'curl [^|]*\| *sh' lokidoki/ run.sh run.bat
    # should return zero.
    ```

## Verify

```bash
uv run pytest -x && \
python3 scripts/build_offline_bundle.py --profile=$(uv run python -c 'from lokidoki.core.platform import detect_profile; print(detect_profile())') --output=/tmp/lokidoki-offline-test && \
python3 scripts/verify_offline_bundle.py /tmp/lokidoki-offline-test && \
rm -rf .lokidoki && \
./run.sh --offline-bundle=/tmp/lokidoki-offline-test --no-browser &
RUN_PID=$!
# should complete without network — fail fast if any preflight tries to download
for i in $(seq 1 600); do curl -sf http://127.0.0.1:8000/api/health && break; sleep 1; done
curl -sf http://127.0.0.1:8000/api/health | grep -q ok && \
kill $RUN_PID
```

## Commit message

```
feat(bootstrap): offline bundle + README rewrite + AGENTS.md architecture

Ship scripts/build_offline_bundle.py + verify_offline_bundle.py for
air-gapped installs — pre-downloads every pinned artifact and HF
snapshot for the selected profile, writes a manifest with sha256s.
lokidoki/bootstrap/offline.py seeds .lokidoki/cache/ from a sibling
bundle directory on startup.

Wizard gains --reset, --skip-optional, --offline-bundle flags plus
retry and skip buttons.

README install section is rewritten: one command per platform, no
brew / choco / curl-pipe-sh, explicit Intel-Mac-unsupported line.
AGENTS.md gains the bootstrap-architecture bullets so future agents
know where bootstrap code lives and which engine runs on which
profile.

Closes docs/bootstrap_rewrite/PLAN.md.
```

## Deferrals

## Deferred from Chunk 4

- **Add `faster-whisper` + `openwakeword` to `pyproject.toml`.** The audio warm-up subprocesses (`install-whisper`, `install-wake-word`) currently swallow `ImportError` and exit 0 so the pipeline can reach `spawn-app` on a fresh checkout. Once the voice subsystem actually needs these packages at runtime, add them to `[project.dependencies]`, regenerate `uv.lock`, and drop the `except ImportError: sys.exit(0)` guards in `lokidoki/bootstrap/preflight/whisper_runtime.py::_warm_faster_whisper` and `lokidoki/bootstrap/preflight/wake_word.py::ensure_wake_word`.
- **Repair `frontend/package-lock.json` drift and drop the `npm install` fallback.** `install_frontend_deps` in `lokidoki/bootstrap/preflight/frontend.py` tries `npm ci` first and falls back to `npm install --no-audit --no-fund` when `npm ci` exits nonzero (the current lockfile is missing `@emnapi/core`/`@emnapi/runtime` entries). Regenerate the lockfile with a clean `npm install` inside a bumped-node environment, verify reproducibility with `npm ci`, then remove the fallback so bootstrap is strict again.

## Deferred from Chunk 5

- **Migrate `InferenceClient` to the new `HTTPProvider`.** Chunk 5 shipped `lokidoki/core/providers/` + the per-engine preflights, but the existing `lokidoki/core/inference.py::InferenceClient` still speaks Ollama's `/api/generate` + `/api/tags` + `/api/ps`. On `mac` (MLX) and `windows`/`linux` (llama-server) Layer 2's chat path will fail until it routes through `HTTPProvider.chat()` / `chat_stream()`. Full migration blast radius: `lokidoki/core/inference.py`, `lokidoki/core/model_manager.py` (uses `_client.get("/api/tags")` + `/api/ps`), `lokidoki/orchestrator/fallbacks/ollama_client.py` (rename to `llm_client.py`), `lokidoki/orchestrator/fallbacks/__init__.py`, `lokidoki/orchestrator/fallbacks/llm_fallback.py`, `lokidoki/orchestrator/skills/llm_skills.py`, `scripts/enforce_residency.py`, `scripts/bench_llm_models.py`, `tests/unit/test_inference.py` (NDJSON assertions — full rewrite), plus the `OllamaError` import sites. Plan the rewrite as its own chunk; keep the public `generate()` / `generate_stream()` signatures so call sites only swap the import.
- **`ProviderSpec.api_style` is always `openai_compat`.** If Hailo's Ollama fork drops OpenAI compatibility in a future release the spec would need a second value — the current registry trusts that every engine we ship (MLX-LM, llama-server, hailo-ollama ≥ 0.1.37) exposes `/v1/chat/completions`. Revisit if a downstream provider forces the issue.
- **GGUF per-file SHA pinning.** `pull_gguf` trusts HF's server-side integrity because HuggingFace does not publish a stable per-file digest for GGUF quantisations. When the offline-bundle builder in this chunk pre-downloads weights, record the observed sha256 in the manifest so subsequent runs (online or offline) can detect corruption or swap attempts.
- **`hailo_ollama` LLM install is a no-op in chunk 5.** `ensure_llm_engine` logs `"hailo_ollama install deferred to the pi_hailo chunk"` and `pull_llm_weights` / `warm_resident_llm` short-circuit the same way. Chunk 7 owns the real install + `.hef` wiring.
- **MLX thinking-model download cost.** On mac the thinking model is `mlx-community/Qwen3-14B-4bit` (~8 GB). The chunk-5 verify runs `pull-llm-thinking` ahead of `warm-resident-llm` / `spawn-app`, so the full first-run wizard can take longer than the verify's 900 s health-check window on residential internet. When this becomes a user-facing pain point, consider marking `pull-llm-thinking` as `can_skip=True` on low-bandwidth profiles and lazily pulling on first thinking-path request.
