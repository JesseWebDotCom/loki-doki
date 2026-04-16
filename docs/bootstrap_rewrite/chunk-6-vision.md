# Chunk 6 — Vision models per engine

## Goal

Install a vision model on every profile, using the format each engine wants. No profile is left without vision capability.

| Profile | Vision format | Source |
|---|---|---|
| `mac` | MLX 4-bit | `mlx-community/Qwen2-VL-7B-Instruct-4bit` |
| `windows` / `linux` | GGUF + mmproj | `Qwen/Qwen2-VL-7B-Instruct-GGUF` |
| `pi_cpu` | GGUF + mmproj (2B to fit RAM) | `Qwen/Qwen2-VL-2B-Instruct-GGUF` |
| `pi_hailo` | HEF | `Qwen2-VL-2B-Instruct.hef` |

## Files

- `lokidoki/bootstrap/versions.py` — add VISION_GGUF_MMPROJ entries (the separate mmproj files llama.cpp needs for vision).
- `lokidoki/bootstrap/preflight/vision.py` — dispatcher: `ensure_vision(ctx)`; branches by engine.
- `lokidoki/bootstrap/preflight/vision_mlx.py` — mac.
- `lokidoki/bootstrap/preflight/vision_llama_cpp.py` — windows / linux / pi_cpu.
- `lokidoki/bootstrap/steps.py` — wire `install-vision`, `pull-vision-model`.
- `lokidoki/core/providers/registry.py` — extend `ProviderSpec` / resolver to also expose `vision_model`.
- `lokidoki/core/providers/client.py` — add `vision(model, images, prompt, **opts)` method using OpenAI-compatible `/v1/chat/completions` with image content parts.
- `tests/unit/bootstrap/test_vision_dispatch.py`
- `tests/unit/providers/test_vision_client.py`

## Actions

1. **`versions.py` — vision mmproj files.** llama.cpp loads vision models as two files: the language weights (`.gguf`) and the projector (`mmproj-*.gguf`). Both need pinning:
   ```python
   VISION_MMPROJ = {
       # matches PLATFORM_MODELS vision_model values on llama.cpp profiles
       "Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M": {
           "weights_filename": "Qwen2-VL-7B-Instruct-Q4_K_M.gguf",
           "mmproj_filename":  "mmproj-Qwen2-VL-7B-Instruct-f16.gguf",
           # no sha256 pin — we pin HF commit sha via repo_id@<sha> in PLATFORM_MODELS instead
       },
       "Qwen/Qwen2-VL-2B-Instruct-GGUF:Q4_K_M": {
           "weights_filename": "Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
           "mmproj_filename":  "mmproj-Qwen2-VL-2B-Instruct-f16.gguf",
       },
   }
   ```

2. **Dispatcher `ensure_vision(ctx)`**:
   ```python
   async def ensure_vision(ctx):
       engine = PLATFORM_MODELS[ctx.profile]["llm_engine"]
       vision = PLATFORM_MODELS[ctx.profile]["vision_model"]
       if engine == "mlx":
           await ensure_vision_mlx(ctx, vision)
       elif engine in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
           await ensure_vision_llama_cpp(ctx, vision)
       elif engine == "hailo_ollama":
           pass  # HEF handled in chunk 7
   ```

3. **`ensure_vision_mlx(ctx, model_id)`** — mac:
   - `huggingface_hub.snapshot_download(model_id, local_dir=".lokidoki/models/vision/<model_id>")`.
   - No separate mmproj file — MLX VL models bundle everything.
   - Serving: same `mlx_lm.server` process from chunk 5 loads vision-capable models natively. When a request comes with image content, it handles it. No separate vision process.

4. **`ensure_vision_llama_cpp(ctx, model_ref)`** — windows / linux / pi_cpu:
   - Parse `model_ref` (e.g. `"Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M"`) into `repo_id` + quant.
   - Look up mmproj info in `VISION_MMPROJ[model_ref]`.
   - Download both files from HF to `.lokidoki/models/vision/<repo_id>/`.
   - Serving: llama-server supports vision via `--mmproj <path>`. The main llama-server process (from chunk 5) is already serving the text LLM on :11434. We spawn a **second** llama-server instance on :11435 for the vision model. Rationale: keeping a single process and swapping models is slow (disk + prompt cache churn); two processes is simpler, costs ~4-6 GB extra RAM on mac/win/linux (fine), and on pi_cpu the 2B vision model fits comfortably alongside the 4B text model.

5. **Update `ProviderSpec`** to add `vision_model: str` and `vision_endpoint: str`. `resolve_llm_provider` populates both. For mac, `vision_endpoint` equals the LLM endpoint (single process). For llama.cpp profiles, `vision_endpoint` is `:11435`.

6. **Provider `vision(...)` method** in `client.py`:
   - Accept PIL images or raw bytes; base64-encode per OpenAI vision spec.
   - POST to `<vision_endpoint>/v1/chat/completions` with mixed content: `[{"type":"text","text":...}, {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]`.
   - Response is the normal chat-completion stream.

7. **Step wiring** in `steps.py`:
   - `install-vision` → `ensure_vision(ctx)` (no-op on pi_hailo; chunk 7 handles).
   - `pull-vision-model` → same function call (the mac path is a pure download; llama.cpp path is download + mmproj).

8. **Runtime port allocation** in `run_app.py` and `start_llama_server`:
   - Text LLM port: 11434.
   - Vision LLM port: 11435 (llama.cpp profiles only).
   - pi_hailo text + vision run on hailo-ollama's :8000 — chunk 7.

9. **Tests**:
   - `test_vision_dispatch.py`: `ensure_vision` picks the right preflight based on profile engine.
   - `test_vision_client.py`: mock a vision endpoint; verify `HTTPProvider.vision()` encodes images correctly and streams the response.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_vision_dispatch.py tests/unit/providers/test_vision_client.py -x && \
rm -rf .lokidoki/models/vision && \
./run.sh &
RUN_PID=$!
for i in $(seq 1 1200); do curl -sf http://127.0.0.1:8000/api/health && break; sleep 1; done
# verify vision files landed
test -s .lokidoki/models/vision/*/mmproj-* 2>/dev/null || \
  test -s .lokidoki/models/vision/*/*.npz 2>/dev/null  # mlx shard filename
# verify vision server answers
PROFILE=$(uv run python -c "from lokidoki.core.platform import detect_profile; print(detect_profile())")
if [ "$PROFILE" = "mac" ]; then
    curl -sf http://127.0.0.1:11434/v1/models | grep -qi "vl" && echo "MLX vision OK"
else
    curl -sf http://127.0.0.1:11435/v1/models | grep -qi "vl" && echo "llama.cpp vision OK"
fi
kill $RUN_PID
```

## Commit message

```
feat(bootstrap): vision models per engine across every profile

Install a vision model on every profile in the format its engine
expects: MLX 4-bit Qwen2-VL-7B on mac, GGUF + mmproj Qwen2-VL-7B on
windows/linux, GGUF Qwen2-VL-2B on pi_cpu (RAM-sized), HEF on
pi_hailo (chunk 7). Vision never cross-loads — each profile runs the
format its hardware is optimized for.

On mac, MLX serves text + vision from the same mlx_lm.server
process. On llama.cpp profiles, a second llama-server instance
binds :11435 for vision so the text model (on :11434) doesn't suffer
KV-cache churn. Provider abstraction gains `vision()` + a
vision_endpoint field.

Refs docs/bootstrap_rewrite/PLAN.md chunk 6.
```

## Deferrals

*(empty)*
