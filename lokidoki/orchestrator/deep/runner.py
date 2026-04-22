"""Deep-work async runner.

Chunk 18 of the rich-response rollout. Design §10.4 is the contract:

* Explicit user opt-in (enforced upstream via ``envelope.mode == "deep"``).
* Per-profile wall-clock cap — timeouts materialize the partial
  envelope, they do NOT raise to the user.
* Single-concurrent deep turn per session — a second request returns
  a clarification block instead of queuing silently.
* Checkpointed envelope persistence — every stage transition invokes
  the optional ``_deep_checkpoint`` callback on the safe context so a
  client disconnect can't lose the in-progress turn.
* Offline-safe — an already-offline-degraded turn with no local
  evidence returns a clarification block rather than thrashing on a
  dead network.

The runner is a thin deterministic sequencer over
:class:`DeepStageHooks`. Tests substitute per-stage callables to
exercise timeout / concurrency / offline / checkpointing paths
without spinning up routing or an LLM.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.deep.envelope_ops import (
    attach_clarification,
    finalize_all_blocks,
    materialize_partial,
)
from lokidoki.orchestrator.deep.gate import DeepGate
from lokidoki.orchestrator.deep.stages import (
    DeepStageEvent,
    DeepStageHooks,
    DeepStageName,
    default_hooks,
)
from lokidoki.orchestrator.response.envelope import ResponseEnvelope
from lokidoki.orchestrator.response.planner import is_offline_degraded

logger = logging.getLogger("lokidoki.orchestrator.deep.runner")


# Per-profile wall-clock caps from design §10.4 / chunk 18 Actions §1.
# Any profile not in this table falls back to the mac value.
WALL_CLOCK_SECONDS: dict[str, float] = {
    "mac": 45.0,
    "windows": 45.0,
    "linux": 60.0,
    "pi_hailo": 60.0,
    "pi_cpu": 90.0,
}
_DEFAULT_WALL_CLOCK_SECONDS = 45.0

_CONCURRENT_REJECT_REASON = "deep_busy"
_OFFLINE_REJECT_REASON = "deep_offline"
_TIMEOUT_REASON = "deep_timeout"

_CONCURRENT_CLARIFICATION = (
    "Finishing your previous deep turn first. Reply /cancel to stop it."
)
_OFFLINE_CLARIFICATION = (
    "Deep mode needs network evidence, and this device is offline. "
    "Switch back to standard mode or try again once the network is back."
)


# Type alias for the optional checkpoint hook. The pipeline can thread
# a coroutine that snapshots the envelope to persistent storage; tests
# pass a plain list-appender.
CheckpointFn = Callable[[ResponseEnvelope, DeepStageEvent], Awaitable[None]]


@dataclass(slots=True)
class DeepRunResult:
    """Outcome of a deep-work run.

    Attributes:
        envelope: The (possibly upgraded) envelope. Always returned —
            even on rejection / timeout — because the pipeline stores
            it as the canonical response.
        status: One of ``"complete"`` / ``"timeout"`` / ``"rejected"`` /
            ``"failed"``. ``"rejected"`` covers both the concurrency
            gate and the offline guard.
        stages_run: Ordered list of stage names that finished cleanly.
        reason: Short stable token naming why the run ended non-clean.
    """

    envelope: ResponseEnvelope
    status: str
    stages_run: list[DeepStageName] = field(default_factory=list)
    reason: str | None = None


async def run_deep_turn(
    envelope: ResponseEnvelope,
    *,
    safe_context: dict[str, Any] | None = None,
    executions: list[ExecutionResult] | None = None,
    decomposition: object | None = None,
    hooks: DeepStageHooks | None = None,
    wall_clock_s: float | None = None,
    profile: str | None = None,
    session_key: str | None = None,
) -> DeepRunResult:
    """Upgrade ``envelope`` through the deep-work stage pipeline.

    Safe to call on any envelope; it branches on ``envelope.mode``
    internally. When the mode is not ``"deep"`` the envelope is
    returned as-is with ``status="complete"``.

    Args:
        envelope: The envelope produced by the standard synthesis
            pass. Mutated in place.
        safe_context: Shared pipeline context dict. May carry
            ``"session_id"`` (concurrency gate key),
            ``"platform_profile"`` (cap lookup),
            ``"_deep_checkpoint"`` (:data:`CheckpointFn`),
            ``"comparison_subjects"`` (finalize input).
        executions: Successful executions from the standard pass.
        decomposition: Decomposer output driving ``expand_ask``.
        hooks: Override for the default stage implementations.
        wall_clock_s: Explicit wall-clock cap (seconds).
        profile: Platform profile override.
        session_key: Explicit session key for the concurrency gate.

    Returns:
        :class:`DeepRunResult` carrying the (possibly upgraded)
        envelope, the terminal status, and the ordered list of stages
        that finished cleanly.
    """
    ctx: dict[str, Any] = dict(safe_context or {})
    executions = list(executions or [])
    hooks = hooks or default_hooks()

    if envelope.mode != "deep":
        return DeepRunResult(envelope=envelope, status="complete")

    session_key = _resolve_session_key(session_key, ctx)

    if DeepGate.is_busy(session_key):
        logger.info("deep gate busy for session=%s; rejecting", session_key)
        attach_clarification(envelope, _CONCURRENT_CLARIFICATION)
        envelope.status = "complete"
        return DeepRunResult(
            envelope=envelope,
            status="rejected",
            reason=_CONCURRENT_REJECT_REASON,
        )

    if _should_refuse_offline(executions, envelope):
        logger.info("deep turn refused due to offline state")
        attach_clarification(envelope, _OFFLINE_CLARIFICATION)
        envelope.status = "complete"
        envelope.offline_degraded = True
        return DeepRunResult(
            envelope=envelope,
            status="rejected",
            reason=_OFFLINE_REJECT_REASON,
        )

    cap = _resolve_wall_clock(wall_clock_s, profile, ctx)
    checkpoint: CheckpointFn | None = ctx.get("_deep_checkpoint")
    stages_run: list[DeepStageName] = []

    lock = DeepGate.for_session(session_key)
    try:
        async with lock:
            await asyncio.wait_for(
                _drive_stages(
                    envelope=envelope,
                    executions=executions,
                    decomposition=decomposition,
                    hooks=hooks,
                    safe_context=ctx,
                    checkpoint=checkpoint,
                    stages_run=stages_run,
                ),
                timeout=cap,
            )
    except asyncio.TimeoutError:
        logger.warning("deep turn timed out after %.1fs", cap)
        materialize_partial(envelope)
        if checkpoint is not None:
            await _safe_checkpoint(
                checkpoint,
                envelope,
                DeepStageEvent(stage="finalize", phase="timeout", detail="deep turn timed out"),
            )
        envelope.status = "complete"
        return DeepRunResult(
            envelope=envelope,
            status="timeout",
            stages_run=stages_run,
            reason=_TIMEOUT_REASON,
        )
    except Exception:  # noqa: BLE001 - deep runner must never break the turn
        logger.exception("deep turn raised; returning pre-deep envelope")
        materialize_partial(envelope)
        envelope.status = "failed"
        return DeepRunResult(
            envelope=envelope,
            status="failed",
            stages_run=stages_run,
        )

    envelope.status = "complete"
    return DeepRunResult(
        envelope=envelope,
        status="complete",
        stages_run=stages_run,
    )


async def _drive_stages(
    *,
    envelope: ResponseEnvelope,
    executions: list[ExecutionResult],
    decomposition: object | None,
    hooks: DeepStageHooks,
    safe_context: dict[str, Any],
    checkpoint: CheckpointFn | None,
    stages_run: list[DeepStageName],
) -> None:
    """Execute every stage in order and record checkpoints."""
    sub_queries = await _run_stage(
        "expand",
        envelope,
        checkpoint,
        lambda: hooks.expand(decomposition, safe_context),
        stages_run,
    )
    if not isinstance(sub_queries, list):
        sub_queries = []

    gathered: list[ExecutionResult] = await _run_stage(
        "gather",
        envelope,
        checkpoint,
        lambda: hooks.gather(list(sub_queries), safe_context),
        stages_run,
    )
    if not isinstance(gathered, list):
        gathered = []

    await _run_sync_stage(
        "dedupe",
        envelope,
        checkpoint,
        lambda: hooks.dedupe(envelope, gathered),
        stages_run,
    )

    if hooks.summary is not None:
        await _run_stage(
            "summary",
            envelope,
            checkpoint,
            lambda: hooks.summary(envelope, safe_context),  # type: ignore[misc]
            stages_run,
        )

    def _do_finalize() -> None:
        hooks.finalize(envelope, executions + gathered, safe_context)
        finalize_all_blocks(envelope)

    await _run_sync_stage("finalize", envelope, checkpoint, _do_finalize, stages_run)


async def _run_stage(
    name: DeepStageName,
    envelope: ResponseEnvelope,
    checkpoint: CheckpointFn | None,
    body: Callable[[], Awaitable[Any]],
    stages_run: list[DeepStageName],
) -> Any:
    """Wrap one async stage invocation with start/end checkpoint events."""
    start_ts = time.perf_counter()
    if checkpoint is not None:
        await _safe_checkpoint(
            checkpoint, envelope, DeepStageEvent(stage=name, phase="start"),
        )
    try:
        result = await body()
    finally:
        duration_ms = (time.perf_counter() - start_ts) * 1000.0
        logger.debug("deep stage %s finished in %.1fms", name, duration_ms)
    stages_run.append(name)
    if checkpoint is not None:
        await _safe_checkpoint(
            checkpoint, envelope, DeepStageEvent(stage=name, phase="end"),
        )
    return result


async def _run_sync_stage(
    name: DeepStageName,
    envelope: ResponseEnvelope,
    checkpoint: CheckpointFn | None,
    body: Callable[[], Any],
    stages_run: list[DeepStageName],
) -> None:
    """Wrap one synchronous stage with start/end checkpoint events."""
    if checkpoint is not None:
        await _safe_checkpoint(
            checkpoint, envelope, DeepStageEvent(stage=name, phase="start"),
        )
    body()
    stages_run.append(name)
    if checkpoint is not None:
        await _safe_checkpoint(
            checkpoint, envelope, DeepStageEvent(stage=name, phase="end"),
        )


async def _safe_checkpoint(
    checkpoint: CheckpointFn,
    envelope: ResponseEnvelope,
    event: DeepStageEvent,
) -> None:
    """Call the checkpoint hook, swallowing any exceptions.

    Checkpointing is best-effort — a persistence hiccup must NOT
    break the in-flight deep turn. Errors are logged and dropped.
    """
    try:
        await checkpoint(envelope, event)
    except Exception:  # noqa: BLE001
        logger.exception("deep checkpoint raised; continuing")


def _resolve_wall_clock(
    explicit_s: float | None,
    profile: str | None,
    safe_context: dict[str, Any],
) -> float:
    """Pick the wall-clock cap: explicit → profile → default."""
    if explicit_s is not None and explicit_s > 0:
        return float(explicit_s)
    key = str(profile or safe_context.get("platform_profile") or "").strip()
    return WALL_CLOCK_SECONDS.get(key, _DEFAULT_WALL_CLOCK_SECONDS)


def _resolve_session_key(
    explicit: str | None,
    safe_context: dict[str, Any],
) -> str | None:
    if explicit is not None:
        return explicit
    return safe_context.get("session_id")  # type: ignore[return-value]


def _should_refuse_offline(
    executions: list[ExecutionResult],
    envelope: ResponseEnvelope,
) -> bool:
    """True when the device is offline AND no local evidence is on hand."""
    if not is_offline_degraded(executions):
        return False
    if envelope.source_surface:
        return False
    return True


__all__ = [
    "CheckpointFn",
    "DeepRunResult",
    "WALL_CLOCK_SECONDS",
    "run_deep_turn",
]
