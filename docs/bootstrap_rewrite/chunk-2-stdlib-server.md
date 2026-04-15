# Chunk 2 — Stdlib bootstrap server + event model

## Goal

Introduce Layer 1: a stdlib-only HTTP server that serves the install wizard and runs the bootstrap pipeline. At the end of this chunk it binds to a temporary port (7861) so it can coexist with the current FastAPI app on :8000 while later chunks replace the FastAPI-served wizard. Steps are stubbed — real implementations land in chunks 3-7.

## Files

- `lokidoki/bootstrap/__init__.py`
- `lokidoki/bootstrap/__main__.py` — entry for `python -m lokidoki.bootstrap`.
- `lokidoki/bootstrap/server.py` — stdlib `ThreadingHTTPServer`.
- `lokidoki/bootstrap/pipeline.py` — `Pipeline` class: step iteration, history, SSE fan-out.
- `lokidoki/bootstrap/events.py` — typed dataclass events + JSON codec.
- `lokidoki/bootstrap/steps.py` — `build_steps(profile)`; stub `run()`s.
- `lokidoki/bootstrap/context.py` — `StepContext` (without `download`/`run_streamed` implementations — those land chunk 3).
- `lokidoki/bootstrap/ui/index.html`
- `lokidoki/bootstrap/ui/bootstrap.css`
- `lokidoki/bootstrap/ui/bootstrap.js`
- `tests/unit/bootstrap/test_events.py`
- `tests/unit/bootstrap/test_pipeline_replay.py`
- `tests/unit/bootstrap/test_server_smoke.py`

Do **not** touch `lokidoki/main.py`. Legacy FastAPI bootstrap routes stay until chunk 9.

## Actions

1. **Events** (`events.py`) — frozen dataclasses:
   - `StepStart(step_id, label, can_skip=False, est_seconds=None)`
   - `StepLog(step_id, line, stream="stdout")`
   - `StepProgress(step_id, pct, bytes_done=None, bytes_total=None)`
   - `StepDone(step_id, duration_s)`
   - `StepFailed(step_id, error, remediation=None, retryable=True)`
   - `PipelineComplete(app_url)`
   - `PipelineHalted(reason)`
   
   Add `to_json(evt) -> dict` that tags with `{"type": "step_start", ...}` and `from_json(d) -> Event`. Pure stdlib — `dataclasses.asdict` + a type dispatch dict.

2. **`StepContext`** (`context.py`) — dataclass, no method bodies yet:
   - Fields: `data_dir: Path`, `profile: str`, `arch: str`, `os_name: str`, `emit: Callable[[Event], None]`.
   - Method signatures (raise `NotImplementedError` — chunk 3 fills them):
     - `async def run_streamed(self, cmd: list[str], step_id: str, cwd=None, env=None) -> int`
     - `async def download(self, url: str, dest: Path, step_id: str, sha256: str|None=None) -> None`
     - `def augmented_env(self) -> dict[str, str]` — returns `os.environ | {...}` with `.lokidoki/<tool>/bin` prepended to PATH for every tool that exists. Implement in this chunk since it's pure.
     - `def binary_path(self, name: str) -> Path` — returns platform-appropriate path (`.lokidoki/<name>/bin/<name>` on unix, `.lokidoki/<name>/<name>.exe` on windows). Implement.

3. **`Step`** dataclass (`steps.py`):
   ```python
   @dataclass(frozen=True)
   class Step:
       id: str
       label: str
       can_skip: bool = False
       est_seconds: int | None = None
       depends_on: tuple[str, ...] = ()
       run: Callable[[StepContext], Awaitable[None]] = field(default=...)
   ```
   
   `build_steps(profile)` returns a profile-specific list. For this chunk each `run()` is a 500 ms `asyncio.sleep` that emits two `StepLog` lines. The step IDs must match the real ones coming in later chunks so chunks 3-7 only replace `run`, not rename.

   Use these IDs (common to every profile unless marked):
   - `detect-profile`, `embed-python`, `install-uv`, `sync-python-deps`
   - `embed-node`, `install-frontend-deps`, `build-frontend`
   - `install-llm-engine`, `pull-llm-fast`, `pull-llm-thinking`, `warm-resident-llm`
   - `install-vision`, `pull-vision-model`
   - `install-piper`, `install-whisper`, `install-wake-word`
   - `install-detectors`
   - `install-image-gen` (optional everywhere)
   - `seed-database`, `spawn-app`
   
   `pi_hailo`-only: `check-hailo-runtime`, `install-hailo-ollama`, `ensure-hef-files` — inserted before `install-llm-engine`.

4. **`Pipeline`** (`pipeline.py`):
   - Owns `history: list[Event]`, `subscribers: set[asyncio.Queue]`, `done: bool`.
   - `async run(steps, ctx)`: iterate, emit lifecycle events, halt on failure.
   - `async subscribe() -> AsyncIterator[Event]`: replay history, then tail live.
   - `async retry(step_id, ctx)`: re-run a single failed step.

5. **`server.py`** — `ThreadingHTTPServer` binding **127.0.0.1:7861** during this chunk (to coexist with FastAPI on :8000). Routes:
   - `GET /` → 302 → `/bootstrap`
   - `GET /bootstrap` → `ui/index.html`
   - `GET /bootstrap/<file>` → static from `ui/`
   - `GET /api/v1/bootstrap/events` → SSE from `pipeline.subscribe()`
   - `POST /api/v1/bootstrap/retry` → body `{step_id}` → `pipeline.retry`
   - `POST /api/v1/bootstrap/setup` → accept `{admin_username, admin_password, app_name}`; hash with `hashlib.scrypt`; write `.lokidoki/bootstrap_config.json`
   - `GET /api/v1/health` → `{"ok": true}`
   
   One background thread runs an asyncio loop driving the pipeline. Events flow from the loop into each subscriber's `asyncio.Queue` and get fanned out over SSE by the HTTP handler thread.

6. **`__main__.py`** — arg parse `--host`, `--port` (default 7861), `--profile` (override), `--data-dir` (default `.lokidoki`), `--no-open`, `--log-file`. Build `StepContext`, start server, `webbrowser.open` unless `--no-open`, `serve_forever`.

7. **UI** (`ui/index.html` + `bootstrap.css` + `bootstrap.js`) — port the look of the current [lokidoki/static/bootstrap.html](../../lokidoki/static/bootstrap.html) to plain HTML/CSS/JS, no framework:
   - Logo + "Hey, I'm LokiDoki!" splash.
   - Profile badge under the title: "Installing for: macOS (Apple Silicon)" (read from `GET /api/v1/bootstrap/profile` → future route, or render from an embedded data tag in `index.html` written by `server.py`).
   - Step grid — one tile per step with icon, label, status dot, progress bar when `StepProgress.bytes_total` set.
   - Bottom progress bar (% of steps done) + "View detailed logs" toggle.
   - Halt banner rendering `StepFailed.error` + `.remediation` + "Retry" button (POST to `/api/v1/bootstrap/retry`).
   - Skip button on `can_skip=True` tiles (wiring lands in chunk 9; the DOM can appear inert for now).
   - EventSource at `/api/v1/bootstrap/events`. On reconnect, history replay gives us back everything since start.

8. **Tests**:
   - `test_events.py` — every event round-trips `to_json`/`from_json`.
   - `test_pipeline_replay.py` — subscribe after N events, receive all N then live.
   - `test_server_smoke.py` — spin the server on an ephemeral port in a thread; `GET /api/v1/health` returns 200; `/bootstrap` returns HTML; `/api/v1/bootstrap/events` opens and yields ≥1 event in 5s.

## Verify

```bash
uv run pytest tests/unit/bootstrap/ -x && \
uv run python -m lokidoki.bootstrap --port 7861 --no-open --data-dir /tmp/.lokidoki-test &
SERVER_PID=$!
sleep 2
curl -sf http://127.0.0.1:7861/api/v1/health | grep -q '"ok": *true' && \
curl -sf http://127.0.0.1:7861/bootstrap | grep -qi 'LokiDoki' && \
timeout 5 curl -Ns http://127.0.0.1:7861/api/v1/bootstrap/events | head -c 200 | grep -q 'step_start' && \
kill $SERVER_PID
```

## Commit message

```
feat(bootstrap): stdlib http.server layer with typed event model

Add lokidoki/bootstrap/ — a stdlib-only bootstrap server that serves
the install wizard without FastAPI or uvicorn. Ships event dataclasses
(StepStart/Log/Progress/Done/Failed, PipelineComplete), a pipeline
orchestrator with history replay, a StepContext shell, and a plain
HTML/CSS/JS wizard UI.

Runs in parallel with the existing FastAPI-served wizard on port
7861 during the transition. Steps are stubbed; chunks 3-7 replace
them with real preflights.

Refs docs/bootstrap_rewrite/PLAN.md chunk 2.
```

## Deferrals

*(empty)*
