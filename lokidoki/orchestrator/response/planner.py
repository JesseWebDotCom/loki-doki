"""Initial block-stack planner.

Chunk 7 of the rich-response rollout (see
``docs/rich-response/chunk-7-envelope-wire.md``); extended by chunk 12
(``docs/rich-response/chunk-12-planner-mode-backend.md``) to shape the
block list per response mode.

This module produces the list of :class:`Block` slots the synthesis
phase will fill in for a given turn. The block list depends on the
**response mode** (``direct`` / ``standard`` / ``rich`` / ``deep`` /
``search`` / ``artifact``) and on which adapter outputs carry sources
or media:

* ``direct``   — summary only; optional single source when the skill
  produced one. No enrichment.
* ``standard`` — summary, plus sources / media when present, plus
  ``follow_ups``.
* ``rich``     — summary, sources, media, pre-allocated ``key_facts``
  and ``follow_ups``. ``comparison`` is pre-allocated when the
  decomposer signalled a comparison intent.
* ``deep``     — summary, sources, pre-allocated ``key_facts``,
  ``steps``, and ``comparison``. Populated progressively in chunk 18.
* ``search``   — short ``summary`` takeaway, ``sources`` list, and
  ``follow_ups``. Media omitted — search mode is retrieval-first.
* ``artifact`` — short supervisory ``summary`` plus a placeholder
  ``artifact`` block (artifact surface lives on the envelope itself;
  chunks 19-20 wire the renderer).

Later chunks (14, 15, 18, 19, 20) expand the content of
``key_facts`` / ``steps`` / ``comparison`` / ``follow_ups`` /
``artifact`` blocks. Chunk 12 only allocates the slots.

No regex / keyword scanning of user text lives here — all branching
is on structured planner inputs.
"""
from __future__ import annotations

from typing import Iterable

from lokidoki.orchestrator.adapters.base import AdapterOutput
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.mode import (
    PlannerInputs,
    ResponseMode,
    VALID_MODES,
)


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
    planner_inputs: PlannerInputs | None = None,
) -> list[Block]:
    """Allocate the initial block list for a turn.

    Branches on ``mode`` (see module docstring). Unknown modes fall
    back to ``"standard"`` — the rollout must never break a turn
    because a caller passed an unexpected mode string.

    Args:
        adapter_outputs: Iterable of :class:`AdapterOutput` values drawn
            from the turn's successful executions. ``None`` entries are
            tolerated (and ignored) so callers don't have to filter.
        mode: Response mode. One of :data:`ResponseMode`; any other
            value is treated as ``"standard"``.
        planner_inputs: Optional structured planner inputs. Only the
            comparison-intent derivation currently consults this — and
            only for ``rich`` mode. ``None`` is safe.

    Returns:
        A list of :class:`Block` instances, each in
        :attr:`BlockState.loading` with ``seq=0``. Order is
        mode-specific; the summary block is always first.
    """
    has_sources = False
    has_media = False
    for output in adapter_outputs:
        if output is None:
            continue
        if output.sources:
            has_sources = True
        if output.media:
            has_media = True

    # Normalise unknown / empty modes to ``standard``. ``mode`` is a
    # runtime string because callers may pass values read off the wire;
    # the ``ResponseMode`` literal keeps typed sites honest.
    normalized: ResponseMode = _normalize_mode(mode)
    inputs = planner_inputs or PlannerInputs()

    if normalized == "direct":
        return _plan_direct(has_sources)
    if normalized == "rich":
        return _plan_rich(has_sources, has_media, inputs)
    if normalized == "deep":
        return _plan_deep(has_sources)
    if normalized == "search":
        return _plan_search(has_sources)
    if normalized == "artifact":
        return _plan_artifact()
    # Fallthrough: standard.
    return _plan_standard(has_sources, has_media)


def _normalize_mode(mode: str) -> ResponseMode:
    """Return ``mode`` iff it is a known :data:`ResponseMode`, else ``standard``."""
    for known in VALID_MODES:
        if mode == known:
            return known
    return "standard"


def _summary(block_id: str = "summary") -> Block:
    return Block(
        id=block_id,
        type=BlockType.summary,
        state=BlockState.loading,
        seq=0,
    )


def _sources() -> Block:
    return Block(
        id="sources",
        type=BlockType.sources,
        state=BlockState.loading,
        seq=0,
    )


def _media() -> Block:
    return Block(
        id="media",
        type=BlockType.media,
        state=BlockState.loading,
        seq=0,
    )


def _key_facts() -> Block:
    return Block(
        id="key_facts",
        type=BlockType.key_facts,
        state=BlockState.loading,
        seq=0,
    )


def _steps() -> Block:
    return Block(
        id="steps",
        type=BlockType.steps,
        state=BlockState.loading,
        seq=0,
    )


def _comparison() -> Block:
    return Block(
        id="comparison",
        type=BlockType.comparison,
        state=BlockState.loading,
        seq=0,
    )


def _follow_ups() -> Block:
    return Block(
        id="follow_ups",
        type=BlockType.follow_ups,
        state=BlockState.loading,
        seq=0,
    )


def _artifact_placeholder() -> Block:
    # Artifacts are rendered on the envelope's ``artifact_surface``
    # (chunks 19-20). A single ``status`` block inside the stack
    # carries the short supervisory text that accompanies it.
    return Block(
        id="artifact_status",
        type=BlockType.status,
        state=BlockState.loading,
        seq=0,
    )


def _plan_direct(has_sources: bool) -> list[Block]:
    """Summary only; optional single source. Design §10.1."""
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    return blocks


def _plan_standard(has_sources: bool, has_media: bool) -> list[Block]:
    """Default mode: summary + sources/media + follow_ups. Design §10.2."""
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    if has_media:
        blocks.append(_media())
    blocks.append(_follow_ups())
    return blocks


def _plan_rich(
    has_sources: bool,
    has_media: bool,
    inputs: PlannerInputs,
) -> list[Block]:
    """Structured answer: summary + sources/media + key_facts + follow_ups.

    Pre-allocates a ``comparison`` block when the decomposer signalled
    a comparison intent — populated by chunk 14.
    """
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    if has_media:
        blocks.append(_media())
    blocks.append(_key_facts())
    # Comparison intent arrives as a structured signal — the derived
    # ``response_shape="comparison"`` flag set by
    # :func:`lokidoki.orchestrator.pipeline.derivations._derive_response_shape`.
    # Callers pass it through ``PlannerInputs.response_shape``; no
    # regex over ``user_input`` needed.
    if inputs.response_shape == "comparison":
        blocks.append(_comparison())
    blocks.append(_follow_ups())
    return blocks


def _plan_deep(has_sources: bool) -> list[Block]:
    """Deep-work: summary + sources + key_facts + steps + comparison. Design §10.4."""
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    blocks.extend([_key_facts(), _steps(), _comparison()])
    return blocks


def _plan_search(has_sources: bool) -> list[Block]:
    """Retrieval-first: short takeaway + sources list + follow_ups. Design §16.2."""
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    blocks.append(_follow_ups())
    return blocks


def _plan_artifact() -> list[Block]:
    """Artifact mode: short supervisory status + artifact surface (envelope-level).

    Chunks 19-20 render the actual artifact via
    ``envelope.artifact_surface``; the block stack just carries the
    short prose that accompanies the side surface.
    """
    return [_summary(), _artifact_placeholder()]


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


__all__ = [
    "plan_initial_blocks",
    "is_offline_degraded",
]
