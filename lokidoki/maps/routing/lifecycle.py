"""Lazy lifecycle for the local Valhalla sidecar (Chunk 6).

Valhalla only runs while the user is actively routing. The process is
cold-started on the first :meth:`ValhallaLifecycle.ensure_started` call,
kept warm while requests keep arriving (``touch()`` resets the clock),
and torn down after ``idle_timeout_s`` of silence to return the
100–800 MB of resident memory to the LLM.

This module deliberately contains no Valhalla-specific spawn logic —
the HEF paths, config JSON, and health probe live in
:mod:`lokidoki.maps.routing.valhalla`. The lifecycle drives that
router's ``_spawn_locked`` / ``_stop_locked`` / ``_wait_healthy``
helpers under a single :class:`asyncio.Lock` so concurrent first-callers
share one cold-start.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

log = logging.getLogger(__name__)

_DEFAULT_IDLE_S = 900
_WATCHDOG_INTERVAL_S = 60.0


def _resolve_idle_timeout() -> int:
    """Read the idle ceiling from env, falling back to 15 minutes.

    ``LOKIDOKI_VALHALLA_IDLE_S`` is ops-only — exposed for test harnesses
    and operators who want to pin a lower / higher number on a specific
    box without editing settings JSON.
    """
    env = os.environ.get("LOKIDOKI_VALHALLA_IDLE_S")
    if env is None:
        return _DEFAULT_IDLE_S
    try:
        return max(1, int(env))
    except ValueError:
        log.warning(
            "invalid LOKIDOKI_VALHALLA_IDLE_S=%r; falling back to %ss",
            env, _DEFAULT_IDLE_S,
        )
        return _DEFAULT_IDLE_S


class ValhallaLifecycle:
    """Owns the spawn lock, idle clock, and watchdog for one router."""

    def __init__(
        self,
        router: "object",
        *,
        idle_timeout_s: int | None = None,
        watchdog_interval_s: float = _WATCHDOG_INTERVAL_S,
    ) -> None:
        self._router = router
        self._idle_timeout_s = (
            idle_timeout_s if idle_timeout_s is not None
            else _resolve_idle_timeout()
        )
        self._watchdog_interval_s = watchdog_interval_s
        self._lock = asyncio.Lock()
        self._last_request_at: float = 0.0
        self._watchdog_task: asyncio.Task | None = None

    @property
    def idle_timeout_s(self) -> int:
        return self._idle_timeout_s

    @property
    def last_request_at(self) -> float:
        return self._last_request_at

    def touch(self) -> None:
        """Reset the idle clock. Safe from sync code; no lock needed."""
        self._last_request_at = time.monotonic()

    async def ensure_started(self, region_id: str) -> None:
        """Spawn (or respawn) Valhalla for ``region_id``.

        Cheap when the sidecar is already up and serving ``region_id``.
        Concurrent first-callers serialise on ``self._lock`` so only
        one cold-start ever happens.
        """
        async with self._lock:
            self._detect_crash_locked()
            if self._is_active_for(region_id):
                self.touch()
                self._ensure_watchdog_running()
                return
            if self._router_process() is not None:
                # Region switch — Valhalla can't swap tile_dir at runtime.
                await self._router._stop_locked()
            self._router._spawn_locked(region_id)
            try:
                await self._router._wait_healthy()
            except BaseException:
                await self._router._stop_locked()
                raise
            self._router._active_region = region_id
            self.touch()
        self._ensure_watchdog_running()

    async def shutdown(self) -> None:
        """Tear down the sidecar if it's running (used by tests + watchdog)."""
        async with self._lock:
            await self._shutdown_locked()

    # ── internals ────────────────────────────────────────────────

    def _router_process(self):
        return getattr(self._router, "_process", None)

    def _is_active_for(self, region_id: str) -> bool:
        proc = self._router_process()
        return (
            proc is not None
            and getattr(self._router, "_active_region", None) == region_id
        )

    def _detect_crash_locked(self) -> None:
        proc = self._router_process()
        if proc is None:
            return
        poll = getattr(proc, "poll", None)
        if poll is None:
            return
        rc = poll()
        if rc is not None:
            log.warning(
                "valhalla crashed (returncode=%s); next request will respawn",
                rc,
            )
            self._router._process = None
            self._router._active_region = None

    async def _shutdown_locked(self) -> None:
        """Delegate SIGTERM → SIGKILL semantics to the router.

        The router's ``_stop_locked`` already implements the graceful
        terminate-then-kill ladder with the documented 10 s grace
        window; keeping that logic in one place means the lifecycle
        only owns *when* to shut down, not *how*.
        """
        if self._router_process() is None:
            return
        await self._router._stop_locked()

    def _ensure_watchdog_running(self) -> None:
        task = self._watchdog_task
        if task is None or task.done():
            self._watchdog_task = asyncio.create_task(self._watchdog_loop())

    async def _watchdog_loop(self) -> None:
        try:
            while self._router_process() is not None:
                await asyncio.sleep(self._watchdog_interval_s)
                if self._router_process() is None:
                    return
                idle = time.monotonic() - self._last_request_at
                if idle > self._idle_timeout_s:
                    log.info(
                        "valhalla idle %.1fs > %ss; shutting down to free RAM",
                        idle, self._idle_timeout_s,
                    )
                    await self.shutdown()
                    return
        except asyncio.CancelledError:
            return


__all__ = ["ValhallaLifecycle"]
