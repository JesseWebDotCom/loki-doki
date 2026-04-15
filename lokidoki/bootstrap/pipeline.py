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
import json
import logging
import queue
import threading
import time
from typing import TYPE_CHECKING, AsyncIterator, Iterable, Iterator

from .context import StepContext
from .events import (
    Event,
    PipelineComplete,
    PipelineHalted,
    StepDone,
    StepFailed,
    StepLog,
    StepStart,
)


if TYPE_CHECKING:
    # ``steps`` imports preflight modules that import this file. Pull the
    # ``Step`` name only for type hints — runtime never sees this import.
    from .steps import Step


class StepHalt(Exception):
    """A step raises this after emitting its own ``StepFailed``.

    ``Pipeline._run_one`` treats this as a hard failure but skips its
    fallback ``StepFailed`` emit (remediation/retryable would be wrong).
    Steps that need a custom remediation string emit ``StepFailed``
    themselves, then raise ``StepHalt`` to abort the pipeline.
    """


class ProfileFallback(Exception):
    """Raised by a step when the active profile cannot run on this host.

    ``Pipeline.run`` catches it, persists the new profile to
    ``.lokidoki/bootstrap_config.json`` (so a re-run does not re-probe),
    rebuilds the step list via :func:`build_steps`, and restarts from
    the top. The user sees a single banner — no crash, no manual rerun.
    """

    def __init__(self, new_profile: str, reason: str = "") -> None:
        self.new_profile = new_profile
        self.reason = reason
        super().__init__(
            f"falling back to {new_profile}"
            + (f": {reason}" if reason else "")
        )


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
        """Execute ``steps`` in order. Stops on the first failure.

        A step may raise :class:`ProfileFallback` to swap the active
        profile (e.g. ``pi_hailo`` → ``pi_cpu`` when no Hailo HAT is
        attached). The pipeline rewrites its step list, persists the
        decision to ``bootstrap_config.json``, and restarts from the top.
        We allow a single fallback per ``run`` call to keep the loop
        bounded.
        """
        async with self._run_lock:
            current_steps = list(steps)
            fallbacks_used = 0
            max_fallbacks = 1
            while True:
                self._steps_by_id = {s.id: s for s in current_steps}
                try:
                    halted = False
                    for step in self._steps_by_id.values():
                        ok = await self._run_one(step, ctx)
                        if not ok:
                            self.emit(PipelineHalted(reason=f"{step.id} failed"))
                            self.done = True
                            halted = True
                            break
                    if halted:
                        return
                    self.emit(PipelineComplete(app_url=self._app_url))
                    self.done = True
                    return
                except ProfileFallback as fb:
                    if fallbacks_used >= max_fallbacks:
                        self.emit(
                            PipelineHalted(
                                reason=(
                                    f"profile fallback to {fb.new_profile} "
                                    "exhausted retry budget"
                                )
                            )
                        )
                        self.done = True
                        return
                    fallbacks_used += 1
                    old_profile = ctx.profile
                    ctx.profile = fb.new_profile
                    self._persist_profile_fallback(ctx, old_profile, fb)
                    self.emit(
                        StepLog(
                            step_id="profile-fallback",
                            line=(
                                f"Falling back from {old_profile} to "
                                f"{fb.new_profile}: {fb.reason or 'no reason given'}"
                            ),
                        )
                    )
                    # Local import — ``steps`` imports preflight modules
                    # that import this file, so the top-level import cycles.
                    from .steps import build_steps

                    current_steps = list(build_steps(fb.new_profile))
                    self.failed_step_id = None
                    # restart the outer while loop with the rebuilt list

    def _persist_profile_fallback(
        self, ctx: StepContext, old_profile: str, fb: "ProfileFallback"
    ) -> None:
        """Merge fallback metadata into ``.lokidoki/bootstrap_config.json``.

        Re-reads any existing config (admin credentials etc.) so we don't
        clobber ``setup``-time data, then rewrites with the new profile
        info recorded.
        """
        path = ctx.data_dir / "bootstrap_config.json"
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                existing = {}
        except (OSError, ValueError):
            existing = {}
        existing["profile"] = fb.new_profile
        existing["profile_fallback_from"] = old_profile
        existing["profile_fallback_reason"] = fb.reason
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(existing, indent=2), encoding="utf-8")

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
        except ProfileFallback:
            # Surface this to ``run`` so it can rewrite the step list.
            # The step has already emitted its own ``StepFailed``.
            raise
        except StepHalt:
            # Step already emitted its own ``StepFailed`` with remediation.
            self.failed_step_id = step.id
            return False
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
