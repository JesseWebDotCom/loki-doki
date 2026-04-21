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
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType


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


__all__ = ["plan_initial_blocks"]
