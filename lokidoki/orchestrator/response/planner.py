"""Initial block-stack planner.

Chunk 7 of the rich-response rollout (see
``docs/rich-response/chunk-7-envelope-wire.md``).

This module produces the list of :class:`Block` slots the synthesis
phase will fill in for a given turn. The current implementation is
intentionally minimal — it only decides whether the turn needs the
three always-or-often block families:

* ``summary`` — always present. Carries the prose answer.
* ``sources`` — present when any adapter contributed sources.
* ``media``   — present when any adapter contributed media cards.

Later chunks (12, 14, 15) expand the planner to emit ``key_facts``,
``steps``, ``comparison``, ``follow_ups``, ``clarification``, and
``status`` blocks driven by decomposer/planner signals. Mode is
accepted today so call sites don't need to change their signature
once chunk 12 wires the real per-mode planning in.
"""
from __future__ import annotations

from typing import Iterable

from lokidoki.orchestrator.adapters.base import AdapterOutput
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType


# Tokens that identify an execution failure as "the network was gone."
# The executor / skill layer already emits a structured ``error_kind``
# of ``"offline"`` in ``raw_result`` (see
# ``lokidoki/orchestrator/execution/errors.py::ErrorKind.offline``); the
# substring list is the belt-and-suspenders fallback for mechanism
# errors that bubble up raw exception text instead of the typed kind.
#
# Scope note: per CLAUDE.md, regex/keyword heuristics MUST NOT classify
# *user intent*. Inspecting a handler error string for network-failure
# markers classifies an error, not user intent — narrow and explicit on
# purpose.
_OFFLINE_ERROR_MARKERS: tuple[str, ...] = (
    "offline",
    "name or service not known",
    "temporary failure in name resolution",
    "no address associated with hostname",
    "nodename nor servname provided",
    "network is unreachable",
    "network is down",
    "failed to establish a new connection",
    "max retries exceeded",
    "connection refused",
    "no route to host",
    "getaddrinfo failed",
    "dns lookup failed",
    "timed out",
    "read timed out",
    "connecttimeout",
    "read timeout",
)


def plan_initial_blocks(
    adapter_outputs: Iterable[AdapterOutput | None],
    mode: str = "standard",
) -> list[Block]:
    """Allocate the initial block list for a turn.

    Args:
        adapter_outputs: Iterable of :class:`AdapterOutput` values drawn
            from the turn's successful executions. ``None`` entries are
            tolerated (and ignored) so callers don't have to filter.
        mode: Response mode (e.g. ``"standard"``). Accepted for forward
            compatibility — chunk 12 switches planning by mode.

    Returns:
        A list of :class:`Block` instances, each in
        :attr:`BlockState.loading` with ``seq=0``. The summary block is
        always first; sources (if any) follows; media (if any) last.
    """
    del mode  # unused in the minimal shape; chunk 12 wires this up

    has_sources = False
    has_media = False
    for output in adapter_outputs:
        if output is None:
            continue
        if output.sources:
            has_sources = True
        if output.media:
            has_media = True

    blocks: list[Block] = [
        Block(id="summary", type=BlockType.summary, state=BlockState.loading, seq=0),
    ]
    if has_sources:
        blocks.append(
            Block(id="sources", type=BlockType.sources, state=BlockState.loading, seq=0)
        )
    if has_media:
        blocks.append(
            Block(id="media", type=BlockType.media, state=BlockState.loading, seq=0)
        )
    return blocks


def is_offline_degraded(executions: Iterable[ExecutionResult]) -> bool:
    """Return True when any execution on this turn failed because the device is offline.

    Classification rules (in priority order):

    1. **Typed**: ``raw_result["error_kind"] == "offline"`` (the canonical
       signal emitted by
       :class:`lokidoki.orchestrator.execution.errors.ErrorKind.offline`).
    2. **Keyword fallback**: any execution error string that contains a
       recognizable offline marker (DNS failure, connection refused,
       socket timeout, etc.). This is the belt-and-suspenders path for
       skills that surface raw exception text without setting
       ``error_kind``.

    Args:
        executions: Iterable of :class:`ExecutionResult` values from the
            turn. Successful executions are skipped.

    Returns:
        True if at least one failed execution looks like a network
        failure; False otherwise.
    """
    for execution in executions:
        if execution is None or execution.success:
            continue

        raw_result = execution.raw_result if isinstance(execution.raw_result, dict) else {}
        kind = str(raw_result.get("error_kind") or "").strip().lower()
        if kind == "offline":
            return True

        # Fallback — inspect both the canonical ``error`` string and the
        # raw-result ``error`` field (skills put them in either spot).
        for source in (execution.error, raw_result.get("error")):
            if not source:
                continue
            text = str(source).lower()
            if any(marker in text for marker in _OFFLINE_ERROR_MARKERS):
                return True

    return False


__all__ = ["plan_initial_blocks", "is_offline_degraded"]
