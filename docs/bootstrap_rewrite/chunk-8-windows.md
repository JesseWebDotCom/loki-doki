# Chunk 8 — Windows support (run.bat + win branches)

## Goal

Add `windows` as a fully supported profile — clean install on Windows 10+ x86_64 from a fresh machine. Introduce `run.bat` as Layer 0. Every preflight gets a windows branch; every path routes through `pathlib.Path`.

No Ollama involvement on windows — llama.cpp Vulkan is the engine (chunk 5). No Setup.exe from the Ollama project. No Chocolatey / winget.

## Files

- `run.bat`
- `lokidoki/bootstrap/context.py` — windows-aware `run_streamed`, path helpers.
- `lokidoki/bootstrap/preflight/*` — audit every preflight for windows branches.
- `lokidoki/bootstrap/run_app.py` — `CREATE_NEW_PROCESS_GROUP` on windows.
- `lokidoki/bootstrap/__main__.py` — ensure browser open works on windows.
- `.github/workflows/bootstrap-integration-windows.yml`
- `tests/unit/bootstrap/test_windows_paths.py`
- `tests/integration/test_windows_smoke.ps1`

## Actions

1. **Write `run.bat`**:
   ```bat
   @echo off
   setlocal enabledelayedexpansion
   cd /d "%~dp0"

   set PY=
   if exist ".lokidoki\python\python.exe" (
       set "PY=.lokidoki\python\python.exe"
   ) else (
       where py >nul 2>nul && set "PY=py -3"
       if "!PY!"=="" (
           where python >nul 2>nul && set "PY=python"
       )
   )
   if "!PY!"=="" (
       echo LokiDoki needs Python to start.
       echo Install Python 3.11+ from https://www.python.org/downloads/windows/
       echo ^(tick "Add Python to PATH" during install^), then rerun run.bat.
       choice /c YN /m "Open the download page now"
       if not errorlevel 2 start https://www.python.org/downloads/windows/
       exit /b 1
   )

   !PY! -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)"
   if errorlevel 1 (
       echo Python 3.8+ required.
       !PY! --version
       exit /b 1
   )

   set VIRTUAL_ENV=

   for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul
   taskkill /F /FI "WINDOWTITLE eq lokidoki-bootstrap" >nul 2>nul
   timeout /t 1 /nobreak >nul

   title lokidoki-bootstrap
   !PY! -m lokidoki.bootstrap
   ```

2. **`context.py` cross-platform fixes**:
   - `augmented_env()`: join with `os.pathsep`.
   - `run_streamed()`: on windows pass `creationflags=subprocess.CREATE_NEW_PROCESS_GROUP` so Ctrl-C doesn't propagate to children incorrectly. On unix `start_new_session=True`.
   - `binary_path(name)` returns:
     - `.lokidoki/<name>/bin/<name>` on unix (python, uv).
     - `.lokidoki/<name>/<name>.exe` on windows (python, uv).
     - `.lokidoki/node/bin/node` unix, `.lokidoki/node/node.exe` windows (no `bin/`).
     - `.lokidoki/llama.cpp/llama-server` unix, `.lokidoki/llama.cpp/llama-server.exe` windows.
   - A `LAYOUT` dict per-tool centralizes the difference so no helper guesses:
     ```python
     _LAYOUT = {
         "python":       {"unix": "bin/python3",       "win": "python.exe"},
         "uv":           {"unix": "bin/uv",            "win": "uv.exe"},
         "node":         {"unix": "bin/node",          "win": "node.exe"},
         "llama_server": {"unix": "llama-server",      "win": "llama-server.exe"},
         "piper":        {"unix": "piper",             "win": "piper.exe"},
     }
     ```

3. **Python tarball extraction on windows**: python-build-standalone ships `.tar.gz` on every platform. `tarfile` works on windows. Layout inside the archive is `python/python.exe`, `python/Lib/...`, `python/Scripts/...` — no `bin/`. The `binary_path("python")` helper already knows this.

4. **uv**: ships `.zip` on windows. Dispatch extraction on file extension:
   ```python
   if filename.endswith(".zip"):
       with zipfile.ZipFile(cache) as z: z.extractall(dest)
   else:
       with tarfile.open(cache) as t: t.extractall(dest)
   ```

5. **Node on windows**: `.zip` file, top dir `node-v20.18.0-win-x64/`, contains `node.exe`, `npm.cmd`, `npx.cmd`. Flatten one level into `.lokidoki/node/`.

6. **llama.cpp on windows**: `.zip` (`llama-b4xxx-bin-win-vulkan-x64.zip`). Extract to `.lokidoki/llama.cpp/`. Vulkan build bundles `llama-server.exe` and the Vulkan runtime DLLs. Do not relocate DLLs — they must sit alongside the exe.

7. **Piper on windows**: `piper_windows_amd64.zip`. Binary is `piper.exe`.

8. **`spawn_fastapi_app`** on windows: `creationflags=subprocess.CREATE_NEW_PROCESS_GROUP`. On shutdown send `CTRL_BREAK_EVENT` via `process.send_signal(signal.CTRL_BREAK_EVENT)`.

9. **Browser open**: `webbrowser.open()` works on windows (delegates to `os.startfile`). No change needed unless the test says otherwise.

10. **`versions.py` coverage check** — test asserts every existing entry has a `("windows", "x86_64")` tuple. All chunks 3-7 should already populate it.

11. **CI workflow** `.github/workflows/bootstrap-integration-windows.yml`:
    - `runs-on: windows-2022`.
    - Triggered by `workflow_dispatch` and PRs with label `bootstrap-integration`.
    - Steps: `actions/checkout`, `cmd /c run.bat` as a background job, poll `http://127.0.0.1:8000/api/health` every 10s for ≤20 min, assert 200, upload `.lokidoki\logs\` as artifacts.

12. **`test_windows_paths.py`**: monkeypatch `os.name="nt"` and `sys.platform="win32"`; assert every `binary_path` call returns a `.exe` path with windows separators via `Path`.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_windows_paths.py -x && \
uv run python -c "
from lokidoki.bootstrap.versions import PYTHON_BUILD_STANDALONE, UV, NODE, LLAMA_CPP, PIPER
for name, spec in [('python', PYTHON_BUILD_STANDALONE), ('uv', UV), ('node', NODE), ('llama_cpp', LLAMA_CPP), ('piper', PIPER)]:
    assert ('windows','x86_64') in spec['artifacts'], f'{name} missing windows x86_64'
print('windows artifact coverage OK')
"
```

Then on a Windows 10/11 machine (or the GH Actions runner via manual dispatch):
```
run.bat
```
Open http://127.0.0.1:8000/bootstrap, watch the pipeline complete, confirm the FastAPI app comes up. Archive `.lokidoki\logs\` for review.

## Commit message

```
feat(bootstrap): windows support via run.bat + cross-platform preflights

Add windows as a first-class profile. run.bat probes for Python via
the Python Launcher (py -3) or PATH, offers to open python.org if
absent, then execs `python -m lokidoki.bootstrap`.

Every preflight gets a windows branch: zip-vs-tar extraction
dispatch, .exe binary paths via a centralized LAYOUT table,
CREATE_NEW_PROCESS_GROUP for subprocess spawning, CTRL_BREAK_EVENT
for shutdown. versions.py carries a win-x86_64 entry for every
runtime; llama.cpp Vulkan works on windows out of the box.

New CI workflow runs the full install against windows-2022 on
demand.

Refs docs/bootstrap_rewrite/PLAN.md chunk 8.
```

## Deferrals

## Deferred from Chunk 7

- Wire `lokidoki/bootstrap/__main__.py` (and the relevant call site in
  `server.py`) to source the stdlib wizard's bind port from
  `run_app.app_port_for(profile)` instead of the hard-coded `--port=8000`
  default. On `pi_hailo` this means the wizard itself listens on `:7860`
  so it does not collide with `hailo-ollama` once the engine starts on
  `:8000`. Chunk 7 added the helpers (`app_port_for` /
  `app_host_for`) and switched the FastAPI spawn over, but `__main__.py`
  / `server.py` were outside chunk 7's `## Files` scope. Touch them
  here, alongside the cross-platform launcher work.
