# Chunk 3 — Embedded Python + uv + deps in wizard

## Goal

Replace `uv run run.py` as the entry point. On first launch the stdlib server (chunk 2) downloads python-build-standalone and uv into `.lokidoki/`, runs `uv sync`, then spawns the FastAPI app under the embedded Python. After this chunk the only pre-UI requirement is "any Python 3.8+ exists on the system."

The FastAPI app binds :8000. The stdlib server moves from :7861 (chunk 2 coexistence port) to :8000 as well, hands off to Layer 2 when done, and exits. During Layer 1's lifetime FastAPI isn't up yet, so there's no collision.

## Files

- `lokidoki/bootstrap/versions.py` — new; PYTHON_BUILD_STANDALONE + UV entries.
- `lokidoki/bootstrap/preflight/__init__.py`
- `lokidoki/bootstrap/preflight/python_runtime.py` — `ensure_embedded_python(ctx)`.
- `lokidoki/bootstrap/preflight/uv_runtime.py` — `ensure_uv(ctx)`.
- `lokidoki/bootstrap/preflight/python_deps.py` — `sync_python_deps(ctx)`.
- `lokidoki/bootstrap/run_app.py` — `spawn_fastapi_app(ctx) -> str`.
- `lokidoki/bootstrap/context.py` — implement `run_streamed` + `download`.
- `lokidoki/bootstrap/steps.py` — wire real `run()`s for `embed-python`, `install-uv`, `sync-python-deps`, `spawn-app`. Bind :8000 in the stdlib server.
- `lokidoki/main.py` — remove `asyncio.create_task(run_bootstrap())` from startup; gate legacy `/bootstrap` routes behind `LOKIDOKI_LEGACY_BOOTSTRAP=1` env var (default off).
- `run.sh` — rewrite as thin interpreter probe.
- `run.py` — deprecation shim.
- `scripts/update_bootstrap_versions.py` — maintenance script.
- `tests/unit/bootstrap/test_versions.py`
- `tests/unit/bootstrap/test_download_integrity.py`
- `tests/integration/test_embedded_python.py` — gated behind `LOKIDOKI_SLOW_TESTS=1`.

## Actions

1. **`versions.py`** — single source of truth for binary downloads (distinct from `PLATFORM_MODELS`):
   ```python
   PYTHON_BUILD_STANDALONE = {
       "tag": "<pinned>",
       "version": "3.12.8",
       "artifacts": {
           ("darwin", "arm64"):   ("cpython-3.12.8+<tag>-aarch64-apple-darwin-install_only.tar.gz", "<sha256>"),
           ("windows","x86_64"):  ("cpython-3.12.8+<tag>-x86_64-pc-windows-msvc-install_only.tar.gz","<sha256>"),
           ("linux",  "aarch64"): ("cpython-3.12.8+<tag>-aarch64-unknown-linux-gnu-install_only.tar.gz","<sha256>"),
           ("linux",  "x86_64"):  ("cpython-3.12.8+<tag>-x86_64-unknown-linux-gnu-install_only.tar.gz","<sha256>"),
       },
       "url_template": "https://github.com/astral-sh/python-build-standalone/releases/download/{tag}/{filename}",
   }
   UV = {
       "version": "0.5.8",
       "artifacts": {
           ("darwin", "arm64"):   ("uv-aarch64-apple-darwin.tar.gz", "<sha256>"),
           ("windows","x86_64"):  ("uv-x86_64-pc-windows-msvc.zip",   "<sha256>"),
           ("linux",  "aarch64"): ("uv-aarch64-unknown-linux-gnu.tar.gz","<sha256>"),
           ("linux",  "x86_64"):  ("uv-x86_64-unknown-linux-gnu.tar.gz", "<sha256>"),
       },
       "url_template": "https://github.com/astral-sh/uv/releases/download/{version}/{filename}",
   }
   PYTHON_MIN_VERSION = (3, 8, 0)  # floor for the *system* Python that launches Layer 1
   ```
   **No Intel mac entry** — Intel macs are unsupported per chunk 1.

2. **`StepContext.download`** — implement:
   - Stream response body in 1 MB chunks; emit `StepProgress` after each.
   - `.part` suffix for in-flight; rename on completion.
   - SHA-256 verify after completion. Mismatch → delete, raise `IntegrityError` with remediation "retry — likely a corrupted download."
   - HTTPS only. Redirect target must also be HTTPS.

3. **`StepContext.run_streamed`** — implement:
   - `asyncio.create_subprocess_exec(*cmd, stdout=PIPE, stderr=STDOUT, cwd=cwd, env=env)`.
   - Read lines, emit `StepLog(step_id, line, stream="stdout")`. Mark stderr lines via the merged stream (`stderr=STDOUT`) — distinction isn't worth the complexity.
   - Return exit code.

4. **`ensure_embedded_python(ctx)`**:
   - Check `ctx.binary_path("python") --version`; if matches `PYTHON_BUILD_STANDALONE["version"]`, return.
   - Else: resolve URL via `(ctx.os_name, ctx.arch)` tuple from `versions.py`. Download to `.lokidoki/cache/`. Extract with `tarfile` into `.lokidoki/python/` (strip the top-level `python/` directory in the tarball). SHA-256 verified by `ctx.download`.

5. **`ensure_uv(ctx)`**: same pattern. Dispatch on file extension — zip on windows, tar.gz on unix.

6. **`sync_python_deps(ctx)`**:
   - Cmd: `[<ctx.binary_path("uv")>, "sync", "--frozen"]`.
   - Env: `UV_PYTHON=<ctx.binary_path("python")>`, `UV_PROJECT_ENVIRONMENT=<repo>/.venv`. Unset `VIRTUAL_ENV`.
   - Pipe through `ctx.run_streamed`. On nonzero exit, tail the last 10 log lines into `StepFailed.remediation`.

7. **`spawn_fastapi_app(ctx) -> str`** in `run_app.py`:
   - Port = 8000 (chunk 7 overrides to 7860 on `pi_hailo`).
   - Bind host = `127.0.0.1` on mac/win/linux; `0.0.0.0` on pi_*.
   - Spawn `.venv/bin/python -m uvicorn lokidoki.main:app --host <host> --port <port>` via `subprocess.Popen` with `start_new_session=True` (unix) / `CREATE_NEW_PROCESS_GROUP` (windows — chunk 8).
   - Poll `http://127.0.0.1:<port>/api/health` every 500ms for ≤30s.
   - On ready: emit `PipelineComplete(app_url=...)`. Stdlib server shuts itself down 5s after the last SSE client disconnects.
   - On timeout/exit: emit `StepFailed` with the last 20 stderr lines as remediation.

8. **Gate legacy FastAPI bootstrap** in `lokidoki/main.py`:
   - Remove `asyncio.create_task(run_bootstrap())` from the startup event.
   - Wrap `/bootstrap` and `/api/v1/bootstrap/status` route definitions in `if os.environ.get("LOKIDOKI_LEGACY_BOOTSTRAP") == "1":`. Default is off; chunk 9 deletes them.
   - The app comes up and serves the SPA + API only. Any attempt to hit `/bootstrap` returns 404.

9. **Move stdlib server from :7861 to :8000** in `server.py` / `__main__.py`. The FastAPI app will also bind :8000 but only after the stdlib server releases the port — ordering handled by `spawn_fastapi_app`.

10. **Rewrite `run.sh`** — terse interpreter probe:
    ```bash
    #!/bin/bash
    cd "$(dirname "$0")"
    if [ -x .lokidoki/python/bin/python3 ]; then PY=.lokidoki/python/bin/python3
    elif command -v python3 >/dev/null 2>&1; then PY=python3
    else
        echo "LokiDoki needs a Python interpreter."
        case "$(uname -s)" in
          Darwin) echo "Install Xcode Command Line Tools: xcode-select --install" ;;
          Linux)  echo "Install python3 from your distribution's package manager." ;;
        esac
        exit 1
    fi
    "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' || { echo "Python 3.8+ required"; exit 1; }
    # arm64 check on mac — Intel not supported
    if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" != "arm64" ]; then
        echo "LokiDoki requires an Apple Silicon (arm64) Mac. Intel Macs are not supported."
        exit 1
    fi
    unset VIRTUAL_ENV
    pgrep -f "lokidoki.bootstrap" | xargs -r kill -9 2>/dev/null
    lsof -ti:8000 2>/dev/null | xargs -r kill -9 2>/dev/null
    exec "$PY" -m lokidoki.bootstrap
    ```

11. **`run.py`** becomes a deprecation shim:
    ```python
    import os, sys
    print("run.py is deprecated — forwarding to `python -m lokidoki.bootstrap`.", file=sys.stderr)
    os.execvp(sys.executable, [sys.executable, "-m", "lokidoki.bootstrap"])
    ```
    Chunk 9 deletes the file.

12. **Tests**:
    - `test_versions.py` — every `artifacts` dict has all four (os, arch) tuples required by the supported profiles; every sha256 is 64 hex chars; every URL is https.
    - `test_download_integrity.py` — `download` with a wrong sha256 raises `IntegrityError` and removes the partial file.
    - `test_embedded_python.py` (gated) — in a temp dir, `ensure_embedded_python` produces a working 3.12 interpreter.

## Verify

```bash
uv run pytest tests/unit/bootstrap/ -x && \
LOKIDOKI_SLOW_TESTS=1 uv run pytest tests/integration/test_embedded_python.py -x -s && \
rm -rf .lokidoki/python .lokidoki/uv && \
./run.sh &
RUN_PID=$!
for i in $(seq 1 300); do curl -sf http://127.0.0.1:8000/api/health && break; sleep 1; done
test -x .lokidoki/python/bin/python3 && \
test -x .lokidoki/uv/bin/uv && \
kill $RUN_PID
```

## Commit message

```
feat(bootstrap): embedded python + uv + uv sync inside the wizard

The stdlib server is now the entry point on port 8000. First run
downloads python-build-standalone 3.12 into .lokidoki/python/,
uv into .lokidoki/uv/, runs `uv sync --frozen` with the embedded
python, and spawns the FastAPI app under that interpreter. All of
this streams into the wizard — no silent pre-UI work remains.

run.sh drops uv install, the Python 3.11 hard requirement, and the
`uv run run.py` exec. It is now a 15-line interpreter probe. The
only environmental prereq is Python 3.8+ on PATH. Intel Macs are
rejected at the shell with a one-line message.

Binary versions + SHA-256 pinned in lokidoki/bootstrap/versions.py.

Refs docs/bootstrap_rewrite/PLAN.md chunk 3.
```

## Deferrals

*(empty)*
