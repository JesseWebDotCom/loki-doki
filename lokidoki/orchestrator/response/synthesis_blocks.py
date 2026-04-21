"""Synthesis-time helpers that populate text-heavy blocks.

Chunk 14 of the rich-response rollout. This module extracts the
``steps`` and ``comparison`` block payloads from the synthesis output
for a turn — ideally via a single constrained-decoding call (see the
"one-call synthesis" principle in design §20.3), with a graceful
fall-back to adapter-only content when the current engine / profile
does not support constrained decoding (or the attempt times out /
errors).

No block is fabricated here:

* ``steps`` is populated from either a constrained JSON shape the
  synthesis LLM was asked to emit, or from adapter output when a
  how-to skill (e.g. ``recipes``) already returned step-shaped text.
  When neither is available the block is marked ``omitted`` — never
  invented.
* ``comparison`` is populated from a constrained JSON shape when
  available, or the subjects-only fallback (left / right labels
  derived from the routing / decomposition entities). Again, when
  the LLM did not emit the shape and no structured entities are
  available the block is marked ``omitted``.

Per-profile constrained-decoding metrics are logged under a tagged
logger so Open Question 1 (decoding speed on ``pi_cpu``) can be
answered from real measurements rather than guesswork.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Iterable

from lokidoki.orchestrator.adapters.base import AdapterOutput
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType

logger = logging.getLogger("lokidoki.orchestrator.response.synthesis_blocks")
metrics = logging.getLogger("lokidoki.orchestrator.response.synthesis_blocks.metrics")


# ---------------------------------------------------------------------------
# Shapes + small helpers
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ExtractionResult:
    """Outcome of one block-extraction attempt.

    Attributes:
        items: Populated for ``steps`` — a list of ``{"n", "text"}``
            dicts. Empty list means "no content available" (caller
            should ``omit``).
        comparison: Populated for ``comparison`` — a dict of shape
            ``{"left": ..., "right": ..., "dimensions": [...]}``. ``None``
            means no comparison content available.
        source: ``"constrained"`` | ``"adapter"`` | ``"none"`` — drives
            the per-profile metric log.
    """

    items: list[dict[str, Any]] | None = None
    comparison: dict[str, Any] | None = None
    source: str = "none"


# Soft cap matching the design-doc intent (§15: enrichment stays
# digestible). Steps beyond 12 almost always mean the LLM ran off into
# boilerplate.
_MAX_STEPS = 12

# Sentinel markers inside synthesis output that opt the synthesis call
# into constrained-JSON mode. Chunk 14 keeps this lightweight: the
# llm_client layer is not aware of grammars yet, so we parse a JSON
# island embedded in the prose. Later chunks (16 voice parity, 18 deep
# mode) will wire the real llama.cpp grammar / MLX constraint path and
# make the block populate natively.
_STEPS_JSON_BLOCK = re.compile(
    r"<blocks:steps>\s*(\{.*?\})\s*</blocks:steps>",
    re.DOTALL,
)
_COMPARISON_JSON_BLOCK = re.compile(
    r"<blocks:comparison>\s*(\{.*?\})\s*</blocks:comparison>",
    re.DOTALL,
)


def _as_str(value: Any, *, max_len: int = 240) -> str:
    text = str(value or "").strip()
    if len(text) > max_len:
        text = text[:max_len].rstrip() + "..."
    return text


def _log_metric(
    *,
    block: str,
    source: str,
    profile: str,
    latency_ms: float,
    success: bool,
) -> None:
    """Profile-tagged metric log.

    Intentionally routed to a separate child logger so a handler can
    tap the metric stream without picking up debug noise from the main
    module logger.
    """
    metrics.info(
        "synthesis_block_extract block=%s source=%s profile=%s latency_ms=%.2f success=%s",
        block,
        source,
        profile or "unknown",
        latency_ms,
        "true" if success else "false",
    )


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------


def _extract_steps_from_constrained(synthesis_text: str) -> list[dict[str, Any]]:
    """Look for an embedded ``<blocks:steps>{...}</blocks:steps>`` island.

    Returns a list of ``{"n", "text"}`` dicts — an empty list if no
    island is found or the parse fails. This is a stand-in for true
    llama.cpp grammar / MLX constraint output; chunks 16/18 will wire
    the real constrained-decoding path.

    The regex is parsing *machine-generated* text (the LLM output, per
    a system-prompt contract), not user input — which is exactly where
    CLAUDE.md permits regex salvage.
    """
    if not synthesis_text:
        return []
    match = _STEPS_JSON_BLOCK.search(synthesis_text)
    if match is None:
        return []
    try:
        payload = json.loads(match.group(1))
    except (ValueError, TypeError):
        return []
    raw_items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        return []
    cleaned: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_items, start=1):
        if len(cleaned) >= _MAX_STEPS:
            break
        if isinstance(entry, str):
            text = _as_str(entry)
            if text:
                cleaned.append({"n": index, "text": text})
            continue
        if isinstance(entry, dict):
            text = _as_str(entry.get("text") or entry.get("step"))
            if not text:
                continue
            item: dict[str, Any] = {"n": index, "text": text}
            substeps = entry.get("substeps")
            if isinstance(substeps, list):
                sub_clean = [
                    _as_str(s)
                    for s in substeps
                    if _as_str(s)
                ]
                if sub_clean:
                    item["substeps"] = sub_clean
            cleaned.append(item)
    return cleaned


def _extract_steps_from_adapters(
    adapter_outputs: Iterable[AdapterOutput | None],
) -> list[dict[str, Any]]:
    """Extract step-shaped text from adapter raw payloads.

    Chunk 14 supports the ``recipes`` skill (raw ``instructions`` text)
    as the canonical how-to adapter backing. Other how-to adapters can
    opt in later by populating the same shape; the logic here is
    defensive — unknown shapes become an empty list rather than a
    fabricated step.
    """
    for output in adapter_outputs:
        if output is None:
            continue
        raw = output.raw or {}
        if not isinstance(raw, dict):
            continue
        recipes = raw.get("recipes")
        if not isinstance(recipes, list) or not recipes:
            continue
        first = recipes[0] if isinstance(recipes[0], dict) else None
        if not first:
            continue
        instructions = first.get("instructions")
        text = _as_str(instructions, max_len=4000)
        if not text:
            continue
        # Split on newline or sentence terminator followed by a capital
        # letter or digit — matches upstream TheMealDB formatting which
        # alternates line-breaks and periods. This splits *machine-
        # generated* text, not user input.
        raw_lines = re.split(r"[\r\n]+|(?<=[.!?])\s+(?=[A-Z0-9])", text)
        cleaned: list[dict[str, Any]] = []
        for idx, line in enumerate(raw_lines, start=1):
            step_text = _as_str(line)
            if not step_text:
                continue
            if len(cleaned) >= _MAX_STEPS:
                break
            cleaned.append({"n": len(cleaned) + 1, "text": step_text})
        if cleaned:
            return cleaned
    return []


def extract_steps(
    *,
    synthesis_text: str | None,
    adapter_outputs: Iterable[AdapterOutput | None],
    profile: str = "",
) -> ExtractionResult:
    """Build a ``steps`` block payload for the current turn.

    Order of preference:

    1. Embedded constrained-JSON island in ``synthesis_text``.
    2. Adapter-only fallback (e.g. recipes instructions).
    3. ``items=None`` + ``source="none"`` — caller omits the block.

    The ``profile`` argument is logged so pi vs mac decoding speed is
    visible in telemetry (Open Question 1).
    """
    started = time.perf_counter()
    constrained_items = _extract_steps_from_constrained(synthesis_text or "")
    if constrained_items:
        latency_ms = (time.perf_counter() - started) * 1000.0
        _log_metric(
            block="steps",
            source="constrained",
            profile=profile,
            latency_ms=latency_ms,
            success=True,
        )
        return ExtractionResult(items=constrained_items, source="constrained")

    adapter_items = _extract_steps_from_adapters(adapter_outputs)
    latency_ms = (time.perf_counter() - started) * 1000.0
    if adapter_items:
        _log_metric(
            block="steps",
            source="adapter",
            profile=profile,
            latency_ms=latency_ms,
            success=True,
        )
        return ExtractionResult(items=adapter_items, source="adapter")

    _log_metric(
        block="steps",
        source="none",
        profile=profile,
        latency_ms=latency_ms,
        success=False,
    )
    return ExtractionResult(items=None, source="none")


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------


def _extract_comparison_from_constrained(
    synthesis_text: str,
) -> dict[str, Any] | None:
    """Parse a constrained-JSON island for the ``comparison`` block."""
    if not synthesis_text:
        return None
    match = _COMPARISON_JSON_BLOCK.search(synthesis_text)
    if match is None:
        return None
    try:
        payload = json.loads(match.group(1))
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    left = payload.get("left")
    right = payload.get("right")
    if not isinstance(left, dict) or not isinstance(right, dict):
        return None
    dimensions = payload.get("dimensions")
    clean_dims: list[str] = []
    if isinstance(dimensions, list):
        for dim in dimensions:
            text = _as_str(dim)
            if text:
                clean_dims.append(text)
    return {
        "left": _normalize_comparison_side(left),
        "right": _normalize_comparison_side(right),
        "dimensions": clean_dims,
    }


def _normalize_comparison_side(side: dict[str, Any]) -> dict[str, Any]:
    """Keep only the fields the frontend renderer needs.

    Accepts ``title`` (string) and ``items`` (list of strings). Any
    other key is dropped so the envelope stays small and the renderer
    contract stays stable.
    """
    title = _as_str(side.get("title") or side.get("name"))
    raw_items = side.get("items")
    cleaned: list[str] = []
    if isinstance(raw_items, list):
        for entry in raw_items:
            text = _as_str(entry)
            if text:
                cleaned.append(text)
    return {"title": title, "items": cleaned}


def _extract_comparison_from_subjects(
    subjects: tuple[str, str] | None,
) -> dict[str, Any] | None:
    """Fallback: build an empty comparison scaffold from two subject names.

    When the synthesis path did not emit a constrained comparison
    island but the decomposer / planner gave us two distinct subjects,
    we still return a skeleton so the UI can show the block labels
    (left / right) and the summary can carry prose narrative. Rows
    stay empty — we do NOT fabricate dimensions.
    """
    if not subjects:
        return None
    left_title = _as_str(subjects[0])
    right_title = _as_str(subjects[1])
    if not left_title or not right_title:
        return None
    return {
        "left": {"title": left_title, "items": []},
        "right": {"title": right_title, "items": []},
        "dimensions": [],
    }


def extract_comparison(
    *,
    synthesis_text: str | None,
    subjects: tuple[str, str] | None,
    profile: str = "",
) -> ExtractionResult:
    """Build a ``comparison`` block payload for the current turn.

    Order of preference:

    1. Embedded constrained-JSON island.
    2. Subject-only scaffold (left / right titles, no dimensions).
    3. ``comparison=None`` — caller omits the block.
    """
    started = time.perf_counter()
    constrained = _extract_comparison_from_constrained(synthesis_text or "")
    if constrained is not None:
        latency_ms = (time.perf_counter() - started) * 1000.0
        _log_metric(
            block="comparison",
            source="constrained",
            profile=profile,
            latency_ms=latency_ms,
            success=True,
        )
        return ExtractionResult(comparison=constrained, source="constrained")

    scaffold = _extract_comparison_from_subjects(subjects)
    latency_ms = (time.perf_counter() - started) * 1000.0
    if scaffold is not None:
        _log_metric(
            block="comparison",
            source="adapter",
            profile=profile,
            latency_ms=latency_ms,
            success=True,
        )
        return ExtractionResult(comparison=scaffold, source="adapter")

    _log_metric(
        block="comparison",
        source="none",
        profile=profile,
        latency_ms=latency_ms,
        success=False,
    )
    return ExtractionResult(comparison=None, source="none")


# ---------------------------------------------------------------------------
# key_facts
# ---------------------------------------------------------------------------


def aggregate_key_facts(
    adapter_outputs: Iterable[AdapterOutput | None],
    *,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Flatten adapter facts into ``key_facts`` items.

    Deterministic — no LLM, no regex over user text. Facts already
    live on ``AdapterOutput.facts`` as short strings; we dedupe and
    wrap each one as ``{"text": fact}`` to match the block ``items``
    contract.
    """
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for output in adapter_outputs:
        if output is None:
            continue
        for fact in output.facts:
            text = _as_str(fact)
            if not text or text in seen:
                continue
            seen.add(text)
            items.append({"text": text})
            if len(items) >= limit:
                return items
    return items


# ---------------------------------------------------------------------------
# Block population helper (called from the pipeline synthesis phase)
# ---------------------------------------------------------------------------


def populate_text_blocks(
    blocks: list[Block],
    *,
    synthesis_text: str | None,
    adapter_outputs: Iterable[AdapterOutput | None],
    comparison_subjects: tuple[str, str] | None = None,
    profile: str = "",
) -> None:
    """Populate ``key_facts`` / ``steps`` / ``comparison`` blocks in place.

    Mutates any such blocks the planner pre-allocated:

    * ``key_facts`` — always deterministic from adapter facts.
    * ``steps`` — constrained-JSON if present, adapter fallback,
      otherwise ``omitted``.
    * ``comparison`` — constrained-JSON if present, subject scaffold
      fallback, otherwise ``omitted``.

    Blocks the planner did not allocate are ignored. The function never
    raises — any failure in extraction degrades to ``omitted``.
    """
    adapter_list = list(adapter_outputs)
    for block in blocks:
        try:
            if block.type is BlockType.key_facts:
                items = aggregate_key_facts(adapter_list)
                block.items = items
                block.state = BlockState.ready if items else BlockState.omitted
                continue
            if block.type is BlockType.steps:
                result = extract_steps(
                    synthesis_text=synthesis_text,
                    adapter_outputs=adapter_list,
                    profile=profile,
                )
                if result.items:
                    block.items = result.items
                    block.state = BlockState.ready
                else:
                    block.items = []
                    block.state = BlockState.omitted
                continue
            if block.type is BlockType.comparison:
                result = extract_comparison(
                    synthesis_text=synthesis_text,
                    subjects=comparison_subjects,
                    profile=profile,
                )
                if result.comparison is not None:
                    block.comparison = result.comparison
                    block.state = BlockState.ready
                else:
                    block.comparison = None
                    block.state = BlockState.omitted
                continue
        except Exception:  # noqa: BLE001 - extraction must never break a turn
            logger.warning(
                "block %s extraction raised; marking omitted",
                block.id,
                exc_info=True,
            )
            block.state = BlockState.omitted


__all__ = [
    "ExtractionResult",
    "aggregate_key_facts",
    "extract_comparison",
    "extract_steps",
    "populate_text_blocks",
]
