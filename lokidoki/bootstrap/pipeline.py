"""Pipeline orchestrator with history replay + live event fan-out.

Owns the canonical ordered list of events the pipeline has emitted.
Subscribers — typically the SSE handler — receive the full history
(so a late-joining browser sees every step) and then tail any new
events. Failures stop the run and emit ``PipelineHalted``; ``retry``
re-runs a single failed step in place.

Fan-out uses :class:`queue.Queue` so HTTP handler threads and the
asyncio event loop running ``run()`` can meet without bridging code
at the call site.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import queue
import threading
import time
from typing import AsyncIterator, Iterable, Iterator

from .context import StepContext
from .events import (
    Event,
    PipelineComplete,
    PipelineHalted,
    StepDone,
    StepFailed,
    StepStart,
)
from .steps import Step


_log = logging.getLogger(__name__)


class Pipeline:
    """Drives a list of :class:`Step`s and fans events out to subscribers."""

    def __init__(self, app_url: str = "http://127.0.0.1:8000") -> None:
        self.history: list[Event] = []
        self.subscribers: set[queue.Queue[Event]] = set()
        self.done: bool = False
        self.failed_step_id: str | None = None
        self._steps_by_id: dict[str, Step] = {}
        self._app_url = app_url
        self._history_lock = threading.Lock()
        self._subs_lock = threading.Lock()
        self._run_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # event publishing
    # ------------------------------------------------------------------
    def emit(self, evt: Event) -> None:
        """Append ``evt`` to history and push it to every live subscriber."""
        with self._history_lock:
            self.history.append(evt)
        with self._subs_lock:
            queues = list(self.subscribers)
        for q in queues:
            try:
                q.put_nowait(evt)
            except queue.Full:  # pragma: no cover - unbounded by default
                _log.warning("subscriber queue full; dropping event")

    # ------------------------------------------------------------------
    # main run
    # ------------------------------------------------------------------
    async def run(self, steps: Iterable[Step], ctx: StepContext) -> None:
        """Execute ``steps`` in order. Stops on the first failure."""
        async with self._run_lock:
            self._steps_by_id = {s.id: s for s in steps}
            for step in self._steps_by_id.values():
                ok = await self._run_one(step, ctx)
                if not ok:
                    self.emit(PipelineHalted(reason=f"{step.id} failed"))
                    self.done = True
                    return
            self.emit(PipelineComplete(app_url=self._app_url))
            self.done = True

    async def retry(self, step_id: str, ctx: StepContext) -> bool:
        """Re-run a single previously-failed step in place."""
        step = self._steps_by_id.get(step_id)
        if step is None:
            return False
        async with self._run_lock:
            self.done = False
            ok = await self._run_one(step, ctx)
            if ok:
                self.failed_step_id = None
            return ok

    async def _run_one(self, step: Step, ctx: StepContext) -> bool:
        self.emit(
            StepStart(
                step_id=step.id,
                label=step.label,
                can_skip=step.can_skip,
                est_seconds=step.est_seconds,
            )
        )
        started = time.monotonic()
        try:
            await step.run(ctx)
        except Exception as exc:  # noqa: BLE001 — pipeline must surface every failure
            _log.exception("step %s failed", step.id)
            self.emit(
                StepFailed(
                    step_id=step.id,
                    error=f"{type(exc).__name__}: {exc}",
                    remediation=None,
                    retryable=True,
                )
            )
            self.failed_step_id = step.id
            return False
        self.emit(
            StepDone(step_id=step.id, duration_s=time.monotonic() - started)
        )
        return True

    # ------------------------------------------------------------------
    # subscription
    # ------------------------------------------------------------------
    def _register(self) -> queue.Queue[Event]:
        q: queue.Queue[Event] = queue.Queue()
        # Hold history_lock while registering so no emit can slip between the
        # history snapshot and the subscriber set — otherwise a concurrent
        # event could be appended to history and fanned out before q joins.
        with self._history_lock:
            backlog = list(self.history)
            with self._subs_lock:
                self.subscribers.add(q)
        for evt in backlog:
            q.put_nowait(evt)
        return q

    def _unregister(self, q: queue.Queue[Event]) -> None:
        with self._subs_lock:
            self.subscribers.discard(q)

    def stream(self) -> Iterator[Event]:
        """Thread-side iterator over history + live events. Ends with the pipeline."""
        q = self._register()
        try:
            while True:
                if self.done and q.empty():
                    return
                try:
                    yield q.get(timeout=0.5)
                except queue.Empty:
                    continue
        finally:
            self._unregister(q)

    async def subscribe(self) -> AsyncIterator[Event]:
        """Replay history, then tail live events until the pipeline ends."""
        q = self._register()
        loop = asyncio.get_running_loop()
        try:
            while True:
                if self.done and q.empty():
                    return
                try:
                    evt = await loop.run_in_executor(
                        None, functools.partial(q.get, True, 0.5)
                    )
                except queue.Empty:
                    continue
                yield evt
        finally:
            self._unregister(q)
