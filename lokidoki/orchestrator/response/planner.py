"""Initial block-stack planner.

Chunk 7 of the rich-response rollout (see
``docs/rich-response/chunk-7-envelope-wire.md``); extended by chunk 12
(``docs/rich-response/chunk-12-planner-mode-backend.md``) to shape the
block list per response mode and by chunk 14
(``docs/rich-response/chunk-14-blocks-text.md``) to pre-allocate
``key_facts`` / ``steps`` / ``comparison`` under per-mode enrichment
budgets.

This module produces the list of :class:`Block` slots the synthesis
phase will fill in for a given turn. The block list depends on the
**response mode** (``direct`` / ``standard`` / ``rich`` / ``deep`` /
``search`` / ``artifact``) and on which adapter outputs carry sources
or media:

* ``direct``   — summary only; optional single source when the skill
  produced one. No enrichment.
* ``standard`` — summary, plus sources / media when present, plus at
  most one of ``key_facts`` / ``steps`` / ``comparison`` when the
  decomposer signalled the matching shape, plus ``follow_ups``.
* ``rich``     — summary, sources, media, pre-allocated ``key_facts``,
  and ``follow_ups``. ``steps`` is pre-allocated for how-to /
  troubleshooting capabilities, and ``comparison`` is pre-allocated
  when the decomposer signalled a comparison intent. Chunk 14
  populates all three from synthesis output or adapter facts.
* ``deep``     — summary, sources, pre-allocated ``key_facts``,
  ``steps``, and ``comparison``. Populated progressively in chunk 18.
* ``search``   — short ``summary`` takeaway, ``sources`` list, and
  ``follow_ups``. Media omitted — search mode is retrieval-first.
* ``artifact`` — short supervisory ``summary`` plus a placeholder
  ``artifact`` block (artifact surface lives on the envelope itself;
  chunks 19-20 wire the renderer).

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
# Capability needs the decomposer emits for "walk me through a procedure"
# questions. When one of these lands under ``rich`` (or ``standard`` with
# a single enrichment budget) the planner pre-allocates the ``steps``
# block. The list is sourced from
# :mod:`lokidoki.orchestrator.decomposer.types` ``CAPABILITY_NEEDS`` —
# each value below is a recognized decomposer capability. We do NOT
# regex-scan user text to detect "how do I…" phrasings.
_HOWTO_CAPABILITY_NEEDS: frozenset[str] = frozenset({
    "howto",
})

# Response-shape markers derived deterministically by
# :func:`lokidoki.orchestrator.pipeline.derivations._derive_response_shape`.
# ``troubleshooting`` ("how do I fix…") is the step-shaped sibling of
# ``comparison``; the router tags it when the matched capability lemma
# contains "troubleshoot" / "diagnose" / "fix" or the constraint
# extractor flagged the chunk as a troubleshooting intent.
_STEP_RESPONSE_SHAPES: frozenset[str] = frozenset({
    "troubleshooting",
})


# Per-mode enrichment budget.
#
# Encoded as a flat table (not scattered conditionals) per the chunk
# 14 spec: the keys are the text-heavy block types that the planner
# may pre-allocate on top of the base ``summary`` / ``sources`` /
# ``media`` / ``follow_ups`` skeleton; the values are the allow-count
# for each mode.
#
# ``standard`` may carry at most one of ``{key_facts, steps,
# comparison}`` — the planner picks the most relevant shape when
# the decomposer signalled more than one (comparison > steps >
# key_facts, matching §15 — structure wins over bullets when the
# user asked for a comparison, and a procedure wins over bullets
# when they asked "how do I…").
#
# ``rich`` and ``deep`` allow all three. ``direct`` / ``search`` /
# ``artifact`` allow none — they carry a summary (plus sources
# when present) and nothing else.
_TEXT_BLOCK_BUDGET: dict[ResponseMode, dict[BlockType, int]] = {
    "direct": {
        BlockType.key_facts: 0,
        BlockType.steps: 0,
        BlockType.comparison: 0,
    },
    "standard": {
        BlockType.key_facts: 1,
        BlockType.steps: 1,
        BlockType.comparison: 1,
        # Cross-type budget enforced at allocation time: at most ONE of
        # the three may be populated per turn. See ``_apply_standard_budget``.
    },
    "rich": {
        BlockType.key_facts: 1,
        BlockType.steps: 1,
        BlockType.comparison: 1,
    },
    "deep": {
        BlockType.key_facts: 1,
        BlockType.steps: 1,
        BlockType.comparison: 1,
    },
    "search": {
        BlockType.key_facts: 0,
        BlockType.steps: 0,
        BlockType.comparison: 0,
    },
    "artifact": {
        BlockType.key_facts: 0,
        BlockType.steps: 0,
        BlockType.comparison: 0,
    },
}


# Soft cap on the total number of text-heavy enrichment blocks in
# ``standard`` mode. See design §15 — "standard" is the default
# conversational mode, structure should land on the answer with one
# shape, not three.
_STANDARD_TEXT_BLOCK_CAP = 1


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
    return _plan_standard(has_sources, has_media, inputs)


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


def _plan_standard(
    has_sources: bool,
    has_media: bool,
    inputs: PlannerInputs,
) -> list[Block]:
    """Default mode: summary + sources/media + ≤1 text block + follow_ups.

    Design §10.2 / §15. At most ONE of ``key_facts`` / ``steps`` /
    ``comparison`` is allocated — the most relevant shape. The
    selection order (comparison > steps > key_facts) matches the design
    doc: structure wins over bullets when the user asked for a
    comparison, and a procedure wins when they asked "how do I…".
    """
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    if has_media:
        blocks.append(_media())
    text_block = _select_standard_text_block(inputs)
    if text_block is not None:
        blocks.append(text_block)
    blocks.append(_follow_ups())
    return blocks


def _plan_rich(
    has_sources: bool,
    has_media: bool,
    inputs: PlannerInputs,
) -> list[Block]:
    """Structured answer: summary + sources/media + key_facts [+steps] [+comparison] + follow_ups.

    ``key_facts`` is always pre-allocated (chunk 14 populates it
    deterministically from adapter facts; empty facts land as
    ``omitted``).

    ``steps`` is pre-allocated when the decomposer signalled a how-to
    capability or the derived response shape is ``troubleshooting``.
    ``comparison`` is pre-allocated when the derived response shape is
    ``comparison``. Both are populated from synthesis output /
    adapter fallback in :mod:`lokidoki.orchestrator.response.synthesis_blocks`.
    """
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    if has_media:
        blocks.append(_media())
    blocks.append(_key_facts())
    if _wants_steps(inputs):
        blocks.append(_steps())
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


def _wants_steps(inputs: PlannerInputs) -> bool:
    """Return True when the decomposer signalled a how-to / troubleshooting intent.

    Branches strictly on structured decomposer fields — never on
    ``user_input``. ``capability_need="howto"`` comes from the
    decomposer LLM (see
    :mod:`lokidoki.orchestrator.decomposer.capability_map`);
    ``response_shape="troubleshooting"`` is derived deterministically
    from the constraint extractor + route capability lemmas.
    """
    if inputs.capability_need in _HOWTO_CAPABILITY_NEEDS:
        return True
    if inputs.response_shape in _STEP_RESPONSE_SHAPES:
        return True
    return False


def _select_standard_text_block(inputs: PlannerInputs) -> Block | None:
    """Pick at most one text block for ``standard`` mode.

    Selection priority: ``comparison`` > ``steps`` > (``key_facts``
    intentionally NOT pre-allocated in standard — standard is the
    default conversational mode and unconditionally attaching a
    bullet list on every single answer is the opposite of the
    design-doc intent). The one-block cap
    (:data:`_STANDARD_TEXT_BLOCK_CAP`) is enforced by this function
    returning a single block.

    When no structural signal fires, ``None`` is returned and the
    ``standard`` layout stays summary + sources/media + follow_ups.
    """
    budget = _TEXT_BLOCK_BUDGET.get("standard", {})
    remaining = _STANDARD_TEXT_BLOCK_CAP
    if remaining <= 0:
        return None
    if budget.get(BlockType.comparison, 0) > 0 and inputs.response_shape == "comparison":
        return _comparison()
    if budget.get(BlockType.steps, 0) > 0 and _wants_steps(inputs):
        return _steps()
    return None


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


def text_block_budget(mode: str) -> dict[BlockType, int]:
    """Return the per-mode text-block budget (read-only view).

    Exposed so tests (and the chunk-14 populator) can assert the
    allowance without duplicating the table. Unknown modes return
    the ``standard`` budget — the same fallback ``plan_initial_blocks``
    applies.
    """
    normalized = _normalize_mode(mode)
    return dict(_TEXT_BLOCK_BUDGET.get(normalized, _TEXT_BLOCK_BUDGET["standard"]))


def enforce_text_block_budget(blocks: list[Block], mode: str) -> bool:
    """Return True when ``blocks`` obeys the per-mode text-block budget.

    A belt-and-suspenders guard — the planner never emits a
    budget-violating list on its own; this helper is for external
    callers that mutate the block stack (e.g. chunks 18/20) and for
    the unit tests that assert the contract.

    Rules enforced:

    * Each of ``key_facts`` / ``steps`` / ``comparison`` respects
      its per-mode allow-count from :data:`_TEXT_BLOCK_BUDGET`.
    * In ``standard`` mode, the total across all three is capped at
      :data:`_STANDARD_TEXT_BLOCK_CAP` (1).
    """
    normalized = _normalize_mode(mode)
    budget = _TEXT_BLOCK_BUDGET.get(normalized, _TEXT_BLOCK_BUDGET["standard"])
    counts: dict[BlockType, int] = {
        BlockType.key_facts: 0,
        BlockType.steps: 0,
        BlockType.comparison: 0,
    }
    for block in blocks:
        if block.type in counts:
            counts[block.type] += 1
    for block_type, allowed in budget.items():
        if counts.get(block_type, 0) > allowed:
            return False
    if normalized == "standard":
        total = sum(counts.values())
        if total > _STANDARD_TEXT_BLOCK_CAP:
            return False
    return True


__all__ = [
    "plan_initial_blocks",
    "is_offline_degraded",
    "text_block_budget",
    "enforce_text_block_budget",
]
