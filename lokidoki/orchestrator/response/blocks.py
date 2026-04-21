"""Block primitives for the response envelope.

A single :class:`Block` class is used for every block family; the
renderer (frontend) dispatches on ``type``. Keeping one shape makes
serde trivial and keeps the backend type surface small.

Payload fields are keyed by ``type``:

* ``summary``, ``clarification``, ``status`` → ``content`` (str)
* ``key_facts``, ``steps``, ``sources``, ``media``, ``cta_links``,
  ``follow_ups`` → ``items`` (list of dicts)
* ``comparison`` → ``comparison`` (dict, shape
  ``{"left": ..., "right": ..., "dimensions": [...]}``)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class BlockState(str, Enum):
    """Lifecycle state of a :class:`Block`.

    Matches the states in design §13: a block is declared (``loading``),
    accumulates content (``partial``), settles (``ready``), or leaves
    the turn (``omitted`` / ``failed``). ``failed`` requires
    :attr:`Block.reason` to be populated.
    """

    loading = "loading"
    partial = "partial"
    ready = "ready"
    omitted = "omitted"
    failed = "failed"


class BlockType(str, Enum):
    """Block family discriminator (design §11.3).

    The renderer selects the concrete React component based on this
    value. New families require both a renderer (chunks 8 / 14 / 15)
    and any necessary planner wiring (chunk 12).
    """

    summary = "summary"
    key_facts = "key_facts"
    steps = "steps"
    comparison = "comparison"
    sources = "sources"
    media = "media"
    cta_links = "cta_links"
    clarification = "clarification"
    follow_ups = "follow_ups"
    status = "status"


@dataclass
class Block:
    """One renderable block in the response envelope.

    Attributes:
        id: Stable identifier scoped to the envelope (e.g. ``"summary"``,
            ``"sources-1"``). Used by SSE patch events for idempotent
            reconciliation.
        type: The block family (see :class:`BlockType`).
        state: Lifecycle state (see :class:`BlockState`).
        seq: Monotonically increasing patch counter within this block
            id. The frontend drops patches whose ``seq`` is not greater
            than the last applied ``seq``.
        reason: Populated only when ``state == BlockState.failed`` — one
            short sentence the UI can show (e.g. ``"offline"``,
            ``"skill timeout"``).
        content: Prose payload for text-shaped blocks (``summary``,
            ``clarification``, ``status``).
        items: List-of-dicts payload for collection-shaped blocks
            (``key_facts``, ``steps``, ``sources``, ``media``,
            ``cta_links``, ``follow_ups``).
        comparison: Dict payload for comparison-shaped blocks; expected
            shape ``{"left": ..., "right": ..., "dimensions": [...]}``.
    """

    id: str
    type: BlockType
    state: BlockState = BlockState.loading
    seq: int = 0
    reason: str | None = None
    content: str | None = None
    items: list[dict[str, Any]] | None = None
    comparison: dict[str, Any] | None = None


__all__ = ["Block", "BlockState", "BlockType"]
