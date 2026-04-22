"""Staged evidence pipeline for deep-work turns.

Design §10.4 breaks the deep turn into five sequential stages:

#. ``expand_ask``          — produce 2–4 sub-queries from the decomposer output.
#. ``gather``              — route + execute each sub-query, collect adapter outputs.
#. ``dedupe``              — normalize sources into the envelope's source surface.
#. ``progressive_summary`` — re-synthesize the summary block against the deeper source pool.
#. ``finalize``            — populate ``key_facts`` / ``steps`` / ``comparison`` from gathered material.

Each stage is a pure callable (or an async callable for the I/O-bound
ones). The runner is a deterministic sequencer — it does not own the
implementation of any one stage. Tests substitute individual stages
through a :class:`DeepStageHooks` override so the runner can be
exercised without spinning up routing / LLM machinery.

No regex over user text lives here — ``expand_ask`` works off the
decomposer's structured output (``distilled_query`` / ``resolved_query``
/ ``capability_need``) just like the rest of the rich-response
planner.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Literal

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import ResponseEnvelope

logger = logging.getLogger("lokidoki.orchestrator.deep.stages")


DeepStageName = Literal[
    "expand",
    "gather",
    "dedupe",
    "summary",
    "finalize",
]


@dataclass(slots=True)
class DeepStageEvent:
    """Structured event emitted on every stage entry / exit.

    The runner forwards these into the SSE queue (translated to a
    ``block_patch`` on the live ``status`` block) and into the
    optional ``_deep_checkpoint`` persistence hook so the frontend +
    storage agree on where the turn is.

    Attributes:
        stage: Canonical stage name (see :data:`DeepStageName`).
        phase: ``"start"`` when the stage begins, ``"end"`` on clean
            exit, ``"timeout"`` when the wall-clock cap fired mid-stage.
        detail: Short human-readable phrase shown to the user. Safe to
            display directly; never contains raw exception text.
    """

    stage: DeepStageName
    phase: Literal["start", "end", "timeout"]
    detail: str = ""


# Stage callable signatures --------------------------------------------------
#
# Expressed via the hooks dataclass below rather than as free-standing
# ``Protocol`` classes so substitution in tests is one-line.

ExpandAskFn = Callable[
    [object, dict[str, Any]],  # decomposition, safe_context
    Awaitable[list[str]],
]
GatherFn = Callable[
    [list[str], dict[str, Any]],  # sub_queries, safe_context
    Awaitable[list[ExecutionResult]],
]
DedupeFn = Callable[
    [ResponseEnvelope, Iterable[ExecutionResult]],
    None,
]
SummaryFn = Callable[
    [ResponseEnvelope, dict[str, Any]],
    Awaitable[None],
]
FinalizeFn = Callable[
    [ResponseEnvelope, list[ExecutionResult], dict[str, Any]],
    None,
]


@dataclass(slots=True)
class DeepStageHooks:
    """Pluggable stage implementations.

    Production builds wire these to the real routing + synthesis
    machinery via :func:`default_hooks`. Tests pass their own callables
    so the runner can be exercised deterministically.
    """

    expand: ExpandAskFn
    gather: GatherFn
    dedupe: DedupeFn = field(default_factory=lambda: dedupe_sources)
    summary: SummaryFn | None = None
    finalize: FinalizeFn = field(default_factory=lambda: finalize_blocks)


# ---------------------------------------------------------------------------
# Default stage implementations
# ---------------------------------------------------------------------------


_MAX_SUB_QUERIES = 4
_MIN_SUB_QUERIES = 2


async def expand_ask(
    decomposition: object,
    safe_context: dict[str, Any],
) -> list[str]:
    """Produce 2–4 sub-queries from the decomposer output.

    The real implementation would call the fast Qwen model with a
    constrained JSON grammar. For the initial wire-up we derive
    sub-queries deterministically from the decomposer fields — this
    keeps deep mode usable offline + cheap while the bench pass decides
    whether the LLM call is worth its latency (see design §27 open
    question #1).

    Scope note: this is the only place in the deep package that could
    plausibly want an LLM call; gating it behind a flag makes it easy
    to enable later without restructuring the runner.
    """
    distilled = str(getattr(decomposition, "distilled_query", "") or "").strip()
    resolved = str(getattr(decomposition, "resolved_query", "") or "").strip()
    capability = str(getattr(decomposition, "capability_need", "") or "").strip()

    # Prefer the resolved (antecedent-expanded) form when present, then
    # the distilled form, then fall back to the raw user text on the
    # context (last resort — should not trip in practice).
    base = resolved or distilled
    if not base:
        raw = str(safe_context.get("raw_text", "") or "").strip()
        base = raw

    if not base:
        return []

    sub_queries = [base]
    # Deterministic, structural variants — NEVER a keyword scan of
    # user text. The presence of a capability tells us what kind of
    # evidence the deeper pass should surface (encyclopedic → history
    # / overview; news → recent / current; howto → steps / tutorial).
    _CAPABILITY_VARIANTS: dict[str, tuple[str, ...]] = {
        "encyclopedic": ("overview", "history", "key facts"),
        "medical": ("symptoms", "treatment"),
        "technical_reference": ("specification", "examples"),
        "people_lookup": ("biography", "notable work"),
        "news": ("recent developments", "background"),
        "howto": ("step by step", "common pitfalls"),
        "education": ("fundamentals", "examples"),
    }
    variants = _CAPABILITY_VARIANTS.get(capability, ("background", "context"))
    for suffix in variants:
        candidate = f"{base} {suffix}".strip()
        if candidate and candidate not in sub_queries:
            sub_queries.append(candidate)
        if len(sub_queries) >= _MAX_SUB_QUERIES:
            break

    while len(sub_queries) < _MIN_SUB_QUERIES:
        # Pad with the base query — never fabricate topic-specific
        # variants.
        sub_queries.append(base)
        break
    return sub_queries[:_MAX_SUB_QUERIES]


async def gather_evidence(
    sub_queries: list[str],
    safe_context: dict[str, Any],
) -> list[ExecutionResult]:
    """Execute each sub-query through the standard routing + execute path.

    The default implementation is intentionally a *no-op stub* — the
    real evidence gather hooks into the pipeline's routing / execution
    phases, which require the runtime + decomposition machinery the
    standard turn already ran. Chunk 18 wires the runner through
    :mod:`lokidoki.orchestrator.core.pipeline` where the full state is
    available; that site can pass a production-grade gather via
    :class:`DeepStageHooks` if / when we decide a second routing pass
    is worth the latency on a 4B local model.

    Returning an empty list here means the dedupe + summary stages
    operate on the original turn's executions only — the deep turn
    still emits a refined summary + ``key_facts`` / ``comparison``
    populated from the first pass. That is a strictly non-regressing
    baseline; wiring a real second pass later is purely additive.
    """
    return []


def dedupe_sources(
    envelope: ResponseEnvelope,
    new_executions: Iterable[ExecutionResult],
) -> None:
    """Merge adapter sources from ``new_executions`` into the envelope.

    Dedupes by canonical URL first (identity-compatible with the
    aggregation path in ``_apply_adapter_outputs_to_spec``), then by a
    coarse title match for sources that omit a URL.

    Updates ``envelope.source_surface`` in place + writes the merged
    list into the ``sources`` block (if one exists). Block state is
    flipped to :attr:`BlockState.ready` when at least one source is
    present.
    """
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    merged: list[dict[str, Any]] = []

    for item in envelope.source_surface:
        entry = dict(item)
        url = str(entry.get("url") or "").strip()
        title = str(entry.get("title") or "").strip().lower()
        if url:
            seen_urls.add(url)
        elif title:
            seen_titles.add(title)
        merged.append(entry)

    for execution in new_executions:
        adapter_output: AdapterOutput | None = execution.adapter_output
        if adapter_output is None or not execution.success:
            continue
        for source in adapter_output.sources:
            entry = _source_to_dict(source)
            url = entry.get("url", "")
            title = entry.get("title", "").strip().lower()
            if url and url in seen_urls:
                continue
            if not url and title and title in seen_titles:
                continue
            if url:
                seen_urls.add(url)
            elif title:
                seen_titles.add(title)
            merged.append(entry)

    envelope.source_surface = merged

    sources_block = _find_block(envelope, BlockType.sources)
    if sources_block is not None:
        sources_block.items = list(merged)
        if merged:
            sources_block.state = BlockState.ready
        else:
            sources_block.state = BlockState.omitted


def _source_to_dict(source: Source) -> dict[str, str]:
    """Mirror of ``_source_to_dict`` in pipeline_phases — kept local to
    avoid a dep on the phases module from the deep package."""
    entry: dict[str, str] = {
        "title": source.title or "",
        "url": source.url or "",
    }
    if source.kind:
        entry["type"] = source.kind
    if source.snippet:
        entry["snippet"] = source.snippet
    if source.published_at:
        entry["published_at"] = source.published_at
    if source.author:
        entry["author"] = source.author
    return entry


async def progressive_summary(
    envelope: ResponseEnvelope,
    safe_context: dict[str, Any],
) -> None:
    """Default no-op summary refresh.

    The first synthesis pass already populated ``envelope.blocks[0]``
    with a summary before the deep path ran. Replacing that summary
    requires a second LLM call; the default stage leaves it alone so
    deep mode in minimal builds (and in tests) behaves like a more
    thoroughly sourced standard turn.

    Production wiring supplies a real summary callable via
    :class:`DeepStageHooks` when network + synthesis are available.
    """
    return None


def finalize_blocks(
    envelope: ResponseEnvelope,
    executions: list[ExecutionResult],
    safe_context: dict[str, Any],
) -> None:
    """Populate ``key_facts`` / ``steps`` / ``comparison`` from gathered adapter outputs.

    Delegates to :func:`lokidoki.orchestrator.response.synthesis_blocks.populate_text_blocks`
    so the block-population policy stays in one place (chunk 14 owns
    the constrained-JSON + adapter-fact fallback logic). Imported
    lazily to keep the deep package's import graph minimal on cold
    starts.
    """
    # Imported locally: ``synthesis_blocks`` pulls in the synthesis
    # prompt helpers, which are unnecessary for callers that exercise
    # only gate / runner.
    from lokidoki.orchestrator.response.synthesis_blocks import populate_text_blocks

    adapter_outputs = [
        execution.adapter_output
        for execution in executions
        if execution.adapter_output is not None
    ]
    profile = str(safe_context.get("platform_profile") or "")
    populate_text_blocks(
        envelope.blocks,
        synthesis_text=_summary_content(envelope),
        adapter_outputs=adapter_outputs,
        comparison_subjects=safe_context.get("comparison_subjects"),
        profile=profile,
    )


def _summary_content(envelope: ResponseEnvelope) -> str:
    block = _find_block(envelope, BlockType.summary)
    if block is None:
        return ""
    return str(block.content or "")


def _find_block(envelope: ResponseEnvelope, block_type: BlockType) -> Block | None:
    for block in envelope.blocks:
        if block.type is block_type:
            return block
    return None


def default_hooks() -> DeepStageHooks:
    """Return the production stage hooks (all defaults)."""
    return DeepStageHooks(
        expand=expand_ask,
        gather=gather_evidence,
        dedupe=dedupe_sources,
        summary=progressive_summary,
        finalize=finalize_blocks,
    )


__all__ = [
    "DeepStageEvent",
    "DeepStageHooks",
    "DeepStageName",
    "dedupe_sources",
    "default_hooks",
    "expand_ask",
    "finalize_blocks",
    "gather_evidence",
    "progressive_summary",
]
