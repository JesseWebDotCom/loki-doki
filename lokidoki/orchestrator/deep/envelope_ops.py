"""Envelope-mutation helpers shared between the deep runner and stages.

Kept separate from :mod:`lokidoki.orchestrator.deep.runner` so the
runner module stays under the CLAUDE.md 300-line ceiling. All
functions here mutate the envelope in place — matching the runner's
pattern of passing the envelope by reference through every stage.
"""
from __future__ import annotations

from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import ResponseEnvelope


def attach_clarification(envelope: ResponseEnvelope, question: str) -> None:
    """Replace / insert a clarification block carrying ``question``.

    Keeps the existing ``summary`` block first so the user still sees
    the prose from the fast answer pass (if any). Clarifications ship
    already-``ready`` — no loading skeleton.
    """
    text = str(question or "").strip()
    if not text:
        return

    existing = next(
        (block for block in envelope.blocks if block.type is BlockType.clarification),
        None,
    )
    if existing is not None:
        existing.content = text
        existing.state = BlockState.ready
        return

    block = Block(
        id="clarification",
        type=BlockType.clarification,
        state=BlockState.ready,
        seq=0,
        content=text,
    )
    insert_at = 1 if envelope.blocks and envelope.blocks[0].type is BlockType.summary else 0
    envelope.blocks.insert(insert_at, block)


def materialize_partial(envelope: ResponseEnvelope) -> None:
    """Flip every populated block to ``ready`` so the partial renders cleanly.

    Called on timeout / unexpected raise. Blocks still in ``loading``
    with no content are left as-is; blocks in ``partial`` are promoted
    to ``ready`` so the UI stops showing a skeleton. Failed blocks
    are untouched — their reason was already recorded upstream.
    """
    for block in envelope.blocks:
        if block.state is BlockState.partial:
            block.state = BlockState.ready
        elif block.state is BlockState.loading and _has_content(block):
            block.state = BlockState.ready


def finalize_all_blocks(envelope: ResponseEnvelope) -> None:
    """Promote any still-loading block with content to ``ready``.

    Keeps the deep path's output shape consistent with the standard
    path, where ``_build_envelope`` sets ready/omitted explicitly on
    the blocks it populates.
    """
    for block in envelope.blocks:
        if block.state is BlockState.loading and _has_content(block):
            block.state = BlockState.ready


def _has_content(block: Block) -> bool:
    if block.content:
        return True
    if block.items:
        return True
    if block.comparison:
        return True
    return False


__all__ = [
    "attach_clarification",
    "finalize_all_blocks",
    "materialize_partial",
]
