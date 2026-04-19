# Chunk 6 — Lazy Valhalla sidecar lifecycle

## Goal

The Valhalla routing process runs only when needed. Cold-started on
the first `/api/v1/maps/route` request; kept warm while requests
keep arriving; killed after 15 min of no routing traffic. This
reclaims 100 MB – 800 MB of RAM (depending on installed regions) for
the LLM when the user isn't actively routing. Start trigger is the
*request*, not the frontend opening `/maps`, so the navigation skill
(`lokidoki/orchestrator/skills/navigation.py`) also drives start/stop
— no silent cold-starts on skill-triggered routes.

## Files

- `lokidoki/maps/routing/valhalla.py` — add a `ValhallaLifecycle` manager class; reshape `get_router()` to return a proxy that lazy-starts on first `.route()` call.
- `lokidoki/maps/routing/lifecycle.py` — new. Process spawn + graceful shutdown + idle watchdog. Plain `asyncio` task; no timers on a separate thread.
- `lokidoki/maps/routing/__init__.py` — export any new symbols; unchanged for callers.
- `lokidoki/api/routes/maps.py` — thread the lifecycle: nothing API-facing changes, but on `post_route` handler, bump `lifecycle.touch()` so the idle clock resets.
- `tests/unit/test_valhalla_router.py` — add tests: first call spawns, idle shutdown fires after N seconds (test with `idle_timeout=0.1`), concurrent first-calls queue on one cold-start (don't race-spawn two processes), crashes restart cleanly.

## Actions

1. `lifecycle.py`:
   - `class ValhallaLifecycle` holds: the subprocess handle (or client to the running sidecar), `last_request_at: float`, `idle_timeout_s: int = 900`, a startup lock (async), and a background `_watchdog` task.
   - `async def ensure_started(self) -> None` — cheap no-op if already running; otherwise acquires the lock, spawns the process, waits for its health port to answer, sets `last_request_at = now`. Concurrent callers all await the same lock.
   - `def touch(self) -> None` — synchronous; updates `last_request_at`.
   - `_watchdog` loop: `await asyncio.sleep(60)` then if `now - last_request_at > idle_timeout_s`, gracefully SIGTERM (wait 10 s then SIGKILL if needed) and mark process `None`.
   - Crash detection: `process.returncode is not None` while we thought it was running → emit a warning log, set process to `None`; next request cold-starts again.
2. `valhalla.py`:
   - `get_router()` now returns a thin wrapper whose `.route(req)` calls `await lifecycle.ensure_started()` then forwards.
   - `touch()` is called at the end of every successful `.route()` so both chat-skill and API callers keep it warm.
3. `post_route` handler: no material change, but add a comment noting the lifecycle hook.
4. Configuration: `idle_timeout_s` reads from `settings` (default 900); a `LOKIDOKI_VALHALLA_IDLE_S` env override is fine since it's ops-only (no stub-CDN vibes).
5. Tests with tight `idle_timeout_s` (e.g., 0.25 s) for deterministic behaviour.

## Verify

```bash
pytest tests/unit/test_valhalla_router.py -x
```

Manual smoke (optional): watch `ps` for the Valhalla process; hit
`/route` once — spawns; leave it 16 min — dies; hit `/route` again —
respawns. Measure RSS of the FastAPI process before and after to
confirm RAM really comes back.

## Commit message

```
feat(maps): lazy Valhalla sidecar lifecycle

Routing process spawns on the first /route request and shuts down
after 15 min of no traffic. Reclaims ~100-800 MB of RSS for the LLM
when the user isn't actively routing. Cold-start penalty is a few
seconds while Valhalla mmaps tiles; concurrent first-callers share
one spawn via an async lock.

Driven by request traffic, not frontend UI state — the navigation
skill's chat-triggered routes also keep the process warm / fire a
respawn on demand.

LOKIDOKI_VALHALLA_IDLE_S overrides the 15-min default for testing.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 6.
```

## Deferrals section (append as you discover)

- **Preemptive cold-start on /maps open** — if cold-start latency
  bothers users, the frontend can send a cheap "warm up" ping on
  `/maps` mount. Additive; not needed for correctness.
- **Multi-region lazy mount** — currently Valhalla mounts every
  installed region's tiles at startup. A smarter mount would only
  load tiles for the viewport's covering region. Larger refactor;
  revisit if needed for many-region setups.
