# Chunk 7 — pi_hailo runtime + graceful fallback

## Goal

Make `pi_hailo` a fully-installable profile. Install hailo-ollama on :8000, verify the Hailo runtime (device node, CLI, kernel blacklist), download the pinned HEF files, and fall back to `pi_cpu` gracefully if hardware is missing — [CLAUDE.md:52](../../CLAUDE.md#L52) hard rule.

Also move the FastAPI app + stdlib server to :7860 on `pi_hailo` so they don't collide with hailo-ollama on :8000.

## Files

- `lokidoki/bootstrap/versions.py` — add HAILO_OLLAMA + HEF_FILES.
- `lokidoki/bootstrap/preflight/hailo_runtime.py` — `check_hailo_hardware()`, `ensure_hailo_runtime(ctx)`.
- `lokidoki/bootstrap/preflight/hailo_ollama.py` — `ensure_hailo_ollama(ctx)`, `start_hailo_ollama(ctx)`.
- `lokidoki/bootstrap/preflight/hef_files.py` — `ensure_hef_files(ctx, required)`.
- `lokidoki/bootstrap/preflight/llm_engine.py` — wire `hailo_ollama` branch to the above.
- `lokidoki/bootstrap/preflight/vision.py` — wire `hailo_ollama` branch (HEF for vision).
- `lokidoki/bootstrap/run_app.py` — `app_port_for(profile)`.
- `lokidoki/bootstrap/steps.py` — add `check-hailo-runtime`, `install-hailo-ollama`, `ensure-hef-files`; they replace `install-llm-engine` + `pull-vision-model` on `pi_hailo`.
- `lokidoki/core/providers/registry.py` — `pi_hailo` endpoint = `http://127.0.0.1:8000`.
- `tests/unit/bootstrap/test_hailo_fallback.py`
- `tests/unit/bootstrap/test_hef_files.py`
- `tests/unit/bootstrap/test_port_assignment.py`

## Actions

1. **`versions.py`**:
   ```python
   HAILO_OLLAMA = {
       "version": "<pinned>",
       "artifacts": {
           ("linux", "aarch64"): ("hailo-ollama-linux-arm64.tar.gz", "<sha256>"),
       },
       "url_template": "https://github.com/<upstream>/releases/download/v{version}/{filename}",
   }
   HEF_FILES = {
       # HEF filename → (url, sha256, size_mb)
       "yolov8m.hef":              (...),
       "yolov5s_personface.hef":   (...),
       "Qwen2-VL-2B-Instruct.hef": (...),
   }
   ```

2. **`check_hailo_hardware() -> dict`** — pure detection, no side effects:
   - Returns `{present, device_node, cli, blacklist_ok, missing: list[str]}`.
   - `device_node`: `Path("/dev/hailo0").exists()`.
   - `cli`: `Path("/usr/bin/hailortcli").exists()`.
   - `blacklist_ok`: read `/etc/modprobe.d/blacklist-hailo.conf` and look for `blacklist hailo_pci`.

3. **`ensure_hailo_runtime(ctx)`**:
   - `hw = check_hailo_hardware()`.
   - If `hw.present == False` (device_node + cli both missing):
     - Emit `StepFailed(retryable=False, remediation="Hailo HAT not detected. Reseat the HAT and reboot, or rerun with --profile=pi_cpu to run CPU-only.")`.
     - Raise `ProfileFallback("pi_cpu")` — `pipeline.run` catches, rewrites the step list, restarts from the top. Wizard shows "Falling back to pi_cpu."
   - If `hw.blacklist_ok == False`:
     - Emit `StepFailed(retryable=True, remediation="Hailo kernel module conflict. Run: echo 'blacklist hailo_pci' | sudo tee /etc/modprobe.d/blacklist-hailo.conf && sudo reboot")`.
     - Do NOT auto-fallback — this is user-fixable.
   - Else emit `StepDone`.

4. **Add `ProfileFallback(Exception)` class** in `lokidoki/bootstrap/pipeline.py`. The `Pipeline.run` loop catches it, rewrites the step list via `build_steps(new_profile)`, persists the fallback decision in `.lokidoki/bootstrap_config.json` (so next run doesn't re-probe), and restarts.

5. **`ensure_hailo_ollama(ctx)`**:
   - Download + extract to `.lokidoki/hailo_ollama/`.
   - Probe `http://127.0.0.1:8000/api/version`. If unreachable, spawn the hailo-ollama binary with `start_new_session=True`.
   - Poll until ready.

6. **`start_hailo_ollama(ctx)`**: same spawn+poll pattern as `start_llama_server`, but hits `:8000` and uses the hailo-ollama binary. Its HTTP API is ollama-compatible (OpenAI-compatible at `/v1/chat/completions` plus `/api/tags` for model introspection).

7. **`ensure_hef_files(ctx, required)`**:
   - `required` = the HEF filenames from `PLATFORM_MODELS["pi_hailo"]` — `vision_model`, `object_detector_model`, `face_detector_model` values ending in `.hef`.
   - For each: if already in `.lokidoki/hef/` with matching sha256, skip. Else download, verify.
   - HEF files are 100-500 MB; emit `StepProgress` on every 1 MB chunk.

8. **Wire `llm_engine.py` and `vision.py`** for `hailo_ollama`:
   - `ensure_llm_engine` on `pi_hailo`: calls `ensure_hailo_ollama` + pulls `qwen3:1.7b` via `POST /api/pull` (hailo-ollama supports this).
   - `ensure_vision` on `pi_hailo`: no-op — the HEF is loaded by the subsystem that consumes it, not by a server.

9. **`app_port_for(profile)`** in `run_app.py`:
   ```python
   def app_port_for(profile: str) -> int:
       return 7860 if profile == "pi_hailo" else 8000
   ```
   - Stdlib server uses this in `__main__.py` / `server.py`.
   - FastAPI app uses this in `spawn_fastapi_app`.
   - `resolve_llm_provider("pi_hailo")` returns endpoint `http://127.0.0.1:8000` (hailo-ollama's fixed port).

10. **Bind host per profile** (port forward from old repo [loki-doki-old/app/config.py:188-193](../../../loki-doki-old/app/config.py#L188-L193)):
    - `pi_cpu` + `pi_hailo`: bind `0.0.0.0` so the Pi is reachable from the LAN.
    - `mac` + `windows` + `linux`: bind `127.0.0.1`.
    - Helper in `run_app.py`: `def app_host_for(profile) -> str`.

11. **Step list modifications** in `steps.py` — `pi_hailo` specific:
    - Insert `check-hailo-runtime` after `sync-python-deps` (and before any Hailo-dependent step).
    - Replace `install-llm-engine` with `install-hailo-ollama`.
    - Insert `ensure-hef-files` before `pull-vision-model` (which becomes a no-op on this profile).

12. **Tests**:
    - `test_hailo_fallback.py`: monkeypatch `check_hailo_hardware` to return `present=False`; assert `ensure_hailo_runtime` raises `ProfileFallback("pi_cpu")`; assert `Pipeline.run` catches, rewrites, restarts.
    - `test_hef_files.py`: mocked download; verify skip-if-present and fetch-if-missing.
    - `test_port_assignment.py`: `app_port_for("pi_hailo") == 7860`; all other profiles == 8000.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_hailo_fallback.py tests/unit/bootstrap/test_hef_files.py tests/unit/bootstrap/test_port_assignment.py -x && \
uv run python -c "
from lokidoki.bootstrap.preflight.hailo_runtime import check_hailo_hardware
from lokidoki.bootstrap.run_app import app_port_for, app_host_for
print('hailo present:', check_hailo_hardware()['present'])
print('ports:', [(p, app_port_for(p)) for p in ('mac','windows','linux','pi_cpu','pi_hailo')])
print('hosts:', [(p, app_host_for(p)) for p in ('mac','windows','linux','pi_cpu','pi_hailo')])
"
```

If a Pi 5 + Hailo HAT is available, also run the full wizard there and confirm `check-hailo-runtime` → `install-hailo-ollama` → `ensure-hef-files` → `pull-llm-fast` all succeed with the FastAPI app landing on :7860.

## Commit message

```
feat(bootstrap): pi_hailo runtime, HEF files, graceful fallback

Make pi_hailo a fully installable profile. check-hailo-runtime
validates /dev/hailo0, hailortcli, and the hailo_pci blacklist per
CLAUDE.md hard rules. ensure-hef-files downloads the three pinned
HEFs (yolov8m, yolov5s_personface, Qwen2-VL-2B-Instruct).
install-hailo-ollama fetches and runs the Hailo build on port 8000;
the FastAPI app moves to :7860 on this profile to avoid collision.

Missing Hailo hardware raises ProfileFallback("pi_cpu") — the
pipeline catches it, rewrites the step list, and restarts with a
visible banner. No crash, no user fix required.

Refs docs/bootstrap_rewrite/PLAN.md chunk 7.
```

## Deferrals

*(empty)*
