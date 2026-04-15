# Chunk 5 — LLM engines (MLX, llama.cpp Vulkan/CPU) + provider layer

## Goal

Install and run the right LLM engine for each profile, pull the right LLM weights, and give Layer 2 a uniform HTTP-shaped provider abstraction so application code does not branch on engine or profile.

Three engines are wired in this chunk:
- **MLX** on `mac` — via `mlx-lm` (Python package) with its built-in OpenAI-compatible server.
- **llama.cpp (Vulkan)** on `windows` + `linux` — llama-server binary from upstream releases.
- **llama.cpp (CPU)** on `pi_cpu` — llama-server binary, CPU/NEON build.

`pi_hailo` engine (hailo-ollama) is installed in chunk 7.

## Files

- `lokidoki/bootstrap/versions.py` — add LLAMA_CPP + MLX_LM.
- `lokidoki/bootstrap/preflight/llama_cpp_runtime.py` — `ensure_llama_cpp(ctx)`, `start_llama_server(ctx, model_path)`.
- `lokidoki/bootstrap/preflight/mlx_runtime.py` — `ensure_mlx(ctx)`, `start_mlx_server(ctx, model_id)` (mac only).
- `lokidoki/bootstrap/preflight/llm_models.py` — `pull_gguf(ctx, repo_id, filename, dest)`, `pull_mlx(ctx, repo_id, dest)`.
- `lokidoki/bootstrap/preflight/llm_engine.py` — dispatcher: `ensure_llm_engine(ctx)` that picks the right preflight based on `profile.llm_engine`.
- `lokidoki/core/providers/__init__.py` — provider abstraction (new package).
- `lokidoki/core/providers/spec.py` — `ProviderSpec` dataclass (ported from old repo, adapted).
- `lokidoki/core/providers/registry.py` — `resolve_llm_provider(profile) -> ProviderSpec`.
- `lokidoki/core/providers/client.py` — single `HTTPProvider` class implementing the chat completion shape our code wants, dispatching to OpenAI-compatible endpoints exposed by mlx-lm / llama-server / hailo-ollama.
- `lokidoki/core/inference.py` — update `InferenceClient` to talk to the provider abstraction instead of the Ollama HTTP API directly.
- `lokidoki/orchestrator/fallbacks/ollama_client.py` — rename to `llm_client.py`; update to use the provider.
- `lokidoki/bootstrap/steps.py` — wire `install-llm-engine`, `pull-llm-fast`, `pull-llm-thinking`, `warm-resident-llm` to real implementations.
- `tests/unit/providers/test_spec.py`
- `tests/unit/providers/test_resolve.py`
- `tests/unit/providers/test_http_client.py`
- `tests/unit/bootstrap/test_llama_cpp_install.py`
- `tests/unit/bootstrap/test_mlx_install.py`

## Actions

1. **Extend `versions.py`**:
   ```python
   LLAMA_CPP = {
       "version": "b4xxx",   # pin a specific llama.cpp release tag
       "artifacts": {
           ("windows","x86_64"):  ("llama-b4xxx-bin-win-vulkan-x64.zip",  "<sha256>"),
           ("linux",  "x86_64"):  ("llama-b4xxx-bin-ubuntu-vulkan-x64.zip","<sha256>"),
           ("linux",  "aarch64"): ("llama-b4xxx-bin-ubuntu-arm64.zip",    "<sha256>"),
       },
       "url_template": "https://github.com/ggml-org/llama.cpp/releases/download/{version}/{filename}",
   }
   # mac uses mlx-lm (Python package, no separate binary). Pinned via pyproject.toml.
   MLX_LM = {"version": "0.20.0"}  # enforced by pyproject.toml; listed here for visibility
   ```
   No Intel-mac entry for llama.cpp — we don't support Intel macs at all.

2. **`ensure_llama_cpp(ctx)`** — for windows/linux/pi_cpu:
   - Resolve artifact from `LLAMA_CPP["artifacts"][(ctx.os_name, ctx.arch)]`.
   - Download + extract to `.lokidoki/llama.cpp/`. Binary at `.lokidoki/llama.cpp/llama-server` (unix) or `.lokidoki/llama.cpp/llama-server.exe` (windows).
   - On pi_cpu, the aarch64 linux release is the CPU + NEON build. Vulkan isn't useful on Pi 5 so we intentionally do not pull the Vulkan archive there — check the artifact filename to confirm (it should not contain "vulkan").

3. **`start_llama_server(ctx, model_path, port=11434, context_size=8192)`**:
   - Spawn `llama-server --model <path> --port <port> --ctx-size <n> --host 127.0.0.1 -ngl 999` (Vulkan offloads all layers to the GPU; `-ngl 999` is safe — llama.cpp clamps to available layers).
   - On pi_cpu: drop `-ngl` (no GPU).
   - `start_new_session=True` (unix) / `CREATE_NEW_PROCESS_GROUP` (windows). Log to `.lokidoki/logs/llm.log`.
   - Poll `GET http://127.0.0.1:<port>/health` until ready. llama-server exposes this endpoint.
   - Return the port; Layer 2's provider picks it up.

4. **`ensure_mlx(ctx)`** — mac only:
   - `mlx-lm` is a Python package; `uv sync` in chunk 3 already installed it (pin in `pyproject.toml`).
   - This step verifies the import works: `python -c "import mlx_lm; print(mlx_lm.__version__)"` via `run_streamed`. Fails the step if the import fails with a remediation pointing at macOS version compatibility.

5. **`start_mlx_server(ctx, model_id, port=11434)`**:
   - Spawn `python -m mlx_lm.server --model <model_id> --port <port> --host 127.0.0.1` under the embedded Python (the `.venv`).
   - This exposes an OpenAI-compatible API at `/v1/chat/completions`. Same port as llama-server for consistency.
   - Poll `GET http://127.0.0.1:<port>/v1/models` until ready.

6. **`pull_gguf(ctx, repo_id, filename, dest)`** for llama.cpp profiles:
   - Construct a direct HF URL: `https://huggingface.co/{repo_id}/resolve/main/{filename}`.
   - Download to `.lokidoki/models/llm/{repo_id}/{filename}`.
   - No sha256 in `versions.py` for these — HF doesn't publish a stable digest per file. Instead pin the commit sha (`?ref=<sha>`) in `PLATFORM_MODELS`'s model string (e.g. `"Qwen/Qwen3-8B-GGUF@<sha>:Q4_K_M"`). Parse that format in `llm_models.py`.

7. **`pull_mlx(ctx, repo_id, dest)`** for mac:
   - Use `huggingface_hub.snapshot_download(repo_id, local_dir=dest)` — the mlx-community repos contain quantized MLX shards.
   - Set `HF_HOME=.lokidoki/huggingface` so downloads cache alongside everything else.

8. **Dispatcher `ensure_llm_engine(ctx)`**:
   ```python
   async def ensure_llm_engine(ctx):
       engine = PLATFORM_MODELS[ctx.profile]["llm_engine"]
       if engine == "mlx":              await ensure_mlx(ctx)
       elif engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}: await ensure_llama_cpp(ctx)
       elif engine == "hailo_ollama":   pass  # handled in chunk 7
       else: raise ValueError(engine)
   ```

9. **Provider abstraction** in `lokidoki/core/providers/`:
   - `spec.py`:
     ```python
     @dataclass(frozen=True)
     class ProviderSpec:
         name: str               # "mlx" | "llama_cpp_vulkan" | "llama_cpp_cpu" | "hailo_ollama"
         endpoint: str           # "http://127.0.0.1:11434"
         model_fast: str
         model_thinking: str
         api_style: str          # "openai_compat" for all three — mlx-lm, llama-server, hailo-ollama all expose it
     ```
   - `registry.py`: `resolve_llm_provider(profile)` reads `PLATFORM_MODELS`, returns a `ProviderSpec`. The endpoint is always `http://127.0.0.1:11434` for mac/win/linux/pi_cpu and `http://127.0.0.1:8000` for pi_hailo (hailo-ollama port, per [CLAUDE.md:32](../../CLAUDE.md#L32)).
   - `client.py`: `HTTPProvider` with async methods `chat(model, messages, stream, **opts) -> AsyncIterator[ChatChunk]` and `generate(model, prompt, **opts)`. Since all three engines expose OpenAI-compatible endpoints, one HTTP client works everywhere — it `POST /v1/chat/completions` and streams SSE. Keep-alive is handled by httpx.

10. **Migrate `InferenceClient`** in `lokidoki/core/inference.py` to delegate to `HTTPProvider`. The public method shape does not change; the Ollama-specific `/api/generate` + `/api/tags` calls are replaced by OpenAI-compatible calls.

11. **Rename `fallbacks/ollama_client.py` → `fallbacks/llm_client.py`** and update callers. The file's internals also go through `HTTPProvider`.

12. **Step wiring** in `steps.py`:
    - `install-llm-engine` → `ensure_llm_engine(ctx)`.
    - `pull-llm-fast` → `pull_gguf(...)` or `pull_mlx(...)` based on engine; targets the `llm_fast` model.
    - `pull-llm-thinking` → same, targets `llm_thinking`. On pi_cpu the model is different from fast (chunk 1 bumped to qwen3:4b thinking vs qwen3:4b-instruct fast); downloaded separately. On pi_hailo the thinking model equals the fast model — skip with an "already present" emit.
    - `warm-resident-llm` → `start_llama_server` or `start_mlx_server` with `llm_fast`, then one throwaway chat completion call to force KV cache allocation.

13. **Tests**:
    - `test_spec.py`: `ProviderSpec` serializes / compares correctly.
    - `test_resolve.py`: `resolve_llm_provider("mac")` returns `name="mlx"`, endpoint `:11434`; `("pi_hailo")` returns `hailo_ollama` endpoint `:8000`.
    - `test_http_client.py`: stub an `httpx_mock` OpenAI-compatible server; verify `chat()` streams.
    - `test_llama_cpp_install.py`: mock `ctx.download` with a fake tarball; verify `.lokidoki/llama.cpp/llama-server` appears.
    - `test_mlx_install.py` (mac-only, gated): verify `import mlx_lm` succeeds under the embedded python.

## Verify

```bash
uv run pytest tests/unit/providers/ tests/unit/bootstrap/test_llama_cpp_install.py -x && \
(test "$(uname -s)" = "Darwin" && uv run pytest tests/unit/bootstrap/test_mlx_install.py -x || true) && \
rm -rf .lokidoki/llama.cpp .lokidoki/models/llm && \
./run.sh &
RUN_PID=$!
for i in $(seq 1 900); do curl -sf http://127.0.0.1:8000/api/health && break; sleep 1; done
# LLM server should be running on 11434 (or 8000 for pi_hailo — not this test)
curl -sf http://127.0.0.1:11434/v1/models | grep -qi "qwen" && \
kill $RUN_PID
```

## Commit message

```
feat(bootstrap): per-profile LLM engines — MLX, llama.cpp Vulkan, llama.cpp CPU

Install and run the fastest engine per platform instead of shipping
Ollama everywhere. mac profile uses MLX via mlx-lm (30-50% faster on
Apple Silicon). windows + linux use llama.cpp with Vulkan (wide GPU
coverage with one binary). pi_cpu uses llama.cpp CPU/NEON (lighter
than a daemon, frees RAM for the bumped qwen3:4b model).

Introduce lokidoki/core/providers/ as a thin abstraction: all three
engines expose an OpenAI-compatible API, so one HTTPProvider client
works against all three. Layer 2 code no longer branches on engine
or profile.

Refs docs/bootstrap_rewrite/PLAN.md chunk 5.
```

## Deferrals

*(empty)*
