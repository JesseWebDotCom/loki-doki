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


# Chunk 16 — per-block TTS policy (design §20.2).
#
# The authoritative read/skip decision for each block family. Voice
# parity reads the envelope's ``spoken_text`` (or the trimmed summary
# fallback) and NEVER concatenates block items (sources, media,
# follow-ups) into the spoken output. Clarification is spoken because
# the user has to hear the question to answer it. Status is
# throttle-gated on the frontend (≤1 utterance per phase, >3s gate —
# chunk 15 deferral #4). Everything else is visual-only.
#
# Encoded as a flat literal dict so the frontend can mirror the same
# shape without round-tripping per-block fields through the envelope.
TTS_POLICY: dict[BlockType, str] = {
    BlockType.summary: "speak",
    BlockType.key_facts: "skip",
    BlockType.steps: "skip",
    BlockType.comparison: "skip",
    BlockType.sources: "skip",
    BlockType.media: "skip",
    BlockType.artifact_preview: "skip",
    BlockType.cta_links: "skip",
    BlockType.clarification: "speak",
    BlockType.follow_ups: "skip",
    BlockType.status: "speak",  # throttled on the client; see tts.ts
}


def tts_policy_for(block_type: BlockType) -> str:
    """Return the TTS policy (``"speak"`` / ``"skip"``) for ``block_type``.

    Unknown block types default to ``"skip"`` — voice parity must fail
    closed. Adding a new block family requires a conscious policy
    decision in :data:`TTS_POLICY`, not a silent default that starts
    reading UI chrome aloud.
    """
    return TTS_POLICY.get(block_type, "skip")


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
    clarification_text: str | None = None,
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
        clarification_text: Optional clarification question already
            emitted by the pipeline's ``clarification_question`` event
            (see ``docs/DESIGN.md`` §III.b). When non-empty the planner
            allocates a :attr:`BlockType.clarification` block in the
            ``ready`` state with the given content. Chunk 15 wires
            this through :mod:`lokidoki.orchestrator.core.pipeline_phases`;
            callers that don't track clarification can leave it
            ``None``.

    Returns:
        A list of :class:`Block` instances. Most are in
        :attr:`BlockState.loading` with ``seq=0``; the summary block
        is always first and a ``clarification`` block (when
        allocated) is second and already ``ready``.
    """
    has_sources = False
    has_media = False
    has_follow_ups = False
    for output in adapter_outputs:
        if output is None:
            continue
        if output.sources:
            has_sources = True
        if output.media:
            has_media = True
        # Chunk 15: follow_ups are only allocated when an adapter
        # actually produced candidates. No fabrication — the planner
        # refuses to emit an empty chips row the frontend would have
        # to hide.
        if output.follow_up_candidates:
            has_follow_ups = True

    # Normalise unknown / empty modes to ``standard``. ``mode`` is a
    # runtime string because callers may pass values read off the wire;
    # the ``ResponseMode`` literal keeps typed sites honest.
    normalized: ResponseMode = _normalize_mode(mode)
    inputs = planner_inputs or PlannerInputs()
    clarification = (clarification_text or "").strip() or None

    if normalized == "direct":
        blocks = _plan_direct(has_sources)
    elif normalized == "rich":
        blocks = _plan_rich(has_sources, has_media, inputs, has_follow_ups)
    elif normalized == "deep":
        blocks = _plan_deep(has_sources)
    elif normalized == "search":
        blocks = _plan_search(has_sources, has_follow_ups)
    elif normalized == "artifact":
        blocks = _plan_artifact(has_sources)
    else:
        # Fallthrough: standard.
        blocks = _plan_standard(has_sources, has_media, inputs, has_follow_ups)

    if clarification is not None:
        # Clarification is the second block (right after summary) so
        # the user reads the question before the answer the synthesis
        # LLM may have hedged with.
        blocks.insert(1, _clarification_block(clarification))

    # Chunk 15: always pre-allocate the live status block. The pipeline
    # patches it at phase transitions and flips it to ``omitted`` on
    # ``response_done`` so it disappears from the final envelope.
    if not any(block.type is BlockType.status for block in blocks):
        blocks.append(_status_block())

    return blocks


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


def _clarification_block(question: str) -> Block:
    """Build a ready-state clarification block.

    Unlike the other planner slots, clarification arrives already
    resolved — the ``clarification_question`` event carries the full
    prompt text, so we don't need a ``loading`` window. Placing it in
    ``ready`` immediately keeps the frontend from flashing a skeleton
    for a block that will never receive a delta.
    """
    return Block(
        id="clarification",
        type=BlockType.clarification,
        state=BlockState.ready,
        seq=0,
        content=question,
    )


def _status_block() -> Block:
    """Pre-allocate the live status block in ``loading``.

    Populated by :func:`lokidoki.orchestrator.core.pipeline_phases.emit_status_patch`
    as phases transition; flipped to :attr:`BlockState.omitted` when
    the turn ends so it disappears from the final rendered envelope.
    """
    return Block(
        id="status",
        type=BlockType.status,
        state=BlockState.loading,
        seq=0,
    )


def _artifact_preview() -> Block:
    # Artifacts render in the dedicated surface plus a compact inline
    # teaser inside the block stack.
    return Block(
        id="artifact_preview",
        type=BlockType.artifact_preview,
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
    has_follow_ups: bool,
) -> list[Block]:
    """Default mode: summary + sources/media + ≤1 text block + follow_ups (when candidates exist).

    Design §10.2 / §15. At most ONE of ``key_facts`` / ``steps`` /
    ``comparison`` is allocated — the most relevant shape. The
    selection order (comparison > steps > key_facts) matches the design
    doc: structure wins over bullets when the user asked for a
    comparison, and a procedure wins when they asked "how do I…".

    ``follow_ups`` is only allocated when at least one adapter
    surfaced ``follow_up_candidates`` (chunk 15 — no fabrication).
    """
    blocks: list[Block] = []
    if has_media:
        blocks.append(_media())
    blocks.append(_summary())
    if has_sources:
        blocks.append(_sources())
    text_block = _select_standard_text_block(inputs)
    if text_block is not None:
        blocks.append(text_block)
    if has_follow_ups:
        blocks.append(_follow_ups())
    return blocks


def _plan_rich(
    has_sources: bool,
    has_media: bool,
    inputs: PlannerInputs,
    has_follow_ups: bool,
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
    # Media rides at the top of the bubble (ChatGPT-style media header)
    # so the reader sees images / player cards before the text. The rest
    # of the stack stays in its canonical order.
    blocks: list[Block] = []
    if has_media:
        blocks.append(_media())
    blocks.append(_summary())
    if has_sources:
        blocks.append(_sources())
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
    if has_follow_ups:
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


def _plan_search(has_sources: bool, has_follow_ups: bool) -> list[Block]:
    """Retrieval-first: short takeaway + sources list + (optional) follow_ups. Design §16.2.

    ``follow_ups`` is only emitted when the adapter surfaced real
    candidates (chunk 15 — the planner refuses to allocate empty
    chips rows the frontend would hide).
    """
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    if has_follow_ups:
        blocks.append(_follow_ups())
    return blocks


def _plan_artifact(has_sources: bool) -> list[Block]:
    """Artifact mode: summary + optional sources + artifact preview.

    Chunks 19-20 render the actual artifact via
    ``envelope.artifact_surface``; the block stack carries a compact
    preview card that opens the full surface.
    """
    blocks: list[Block] = [_summary()]
    if has_sources:
        blocks.append(_sources())
    blocks.append(_artifact_preview())
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


def build_status_block() -> Block:
    """Public factory for the live ``status`` block (chunk 15).

    Exposed so the pipeline phases module can insert a fresh status
    block into an envelope that was planned before the clarification /
    status wiring was available (e.g. in tests or the fast-lane path).
    Most callers get the status block from :func:`plan_initial_blocks`
    already — chunk 15 always pre-allocates it.
    """
    return _status_block()


__all__ = [
    "TTS_POLICY",
    "build_status_block",
    "enforce_text_block_budget",
    "is_offline_degraded",
    "plan_initial_blocks",
    "text_block_budget",
    "tts_policy_for",
]
