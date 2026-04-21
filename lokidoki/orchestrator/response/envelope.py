"""Top-level response envelope + structural validation.

See design doc §11.2 / §11.4 for the conceptual shape and the
transport rules this envelope is engineered to support.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType


class EnvelopeValidationError(ValueError):
    """Raised by :func:`validate_envelope` when a structural invariant is violated.

    The message is one terse sentence naming the rule that failed — the
    caller is expected to log it; the UI never sees it.
    """


# Soft cap from design §11.4: sprawl indicates a planner bug, not a
# feature. Kept as a module constant so chunk 12 (planner) and tests
# can reference the same number.
MAX_BLOCKS = 8

# Literal types for envelope mode / status — enumerated here (not as
# Enum) so serde stays string-in / string-out and Pydantic / FastAPI
# response models can consume them without extra coercion when chunk 7
# wires them through the API layer.
EnvelopeMode = Literal[
    "direct",
    "standard",
    "rich",
    "deep",
    "search",
    "artifact",
]
EnvelopeStatus = Literal["streaming", "complete", "failed"]


@dataclass
class Hero:
    """Optional hero card rendered above the block stack.

    Attributes:
        title: Required short title (e.g. entity name, question topic).
        subtitle: Optional one-line qualifier.
        image_url: Optional image. MUST resolve to a local,
            bootstrap-materialized asset — runtime enforcement lives in
            chunk 11 (source surface / offline trust chip).
    """

    title: str
    subtitle: str | None = None
    image_url: str | None = None


@dataclass
class ResponseEnvelope:
    """Canonical per-turn response shape.

    The envelope carries the full reconciled state of one turn:
    top-of-turn hero, ordered block stack, plus two dedicated surfaces
    (sources / artifact) that render outside the main block column.

    Attributes:
        request_id: Stable id for the user turn this envelope answers.
        mode: Response mode (direct / standard / rich / deep / search /
            artifact). Planner-driven; see chunk 12.
        status: Coarse lifecycle — ``streaming`` while blocks are still
            arriving, ``complete`` at ``response_snapshot`` time,
            ``failed`` for a whole-turn failure.
        hero: Optional hero card (see :class:`Hero`).
        blocks: Ordered list of renderable blocks. Capped at
            :data:`MAX_BLOCKS`.
        source_surface: Structured sources rendered in the dedicated
            right-side surface (design §11.3). Items follow the shared
            :class:`lokidoki.orchestrator.adapters.base.Source`
            serialized shape.
        artifact_surface: Populated only in artifact mode (chunks 19–20).
        spoken_text: Short spoken version for voice parity (chunk 16);
            distinct from the summary block prose so TTS can stay
            concise even when the visual answer is rich.
    """

    request_id: str
    mode: EnvelopeMode = "standard"
    status: EnvelopeStatus = "streaming"
    hero: Hero | None = None
    blocks: list[Block] = field(default_factory=list)
    source_surface: list[dict[str, Any]] = field(default_factory=list)
    artifact_surface: dict[str, Any] | None = None
    spoken_text: str | None = None


def validate_envelope(envelope: ResponseEnvelope) -> None:
    """Validate structural invariants on ``envelope``.

    Rules (design §11.4 + chunk-6 spec):

    * Block ``id`` values are unique.
    * Within a block id, ``seq`` never decreases across the envelope's
      history (validated here pointwise — the full monotonic history is
      enforced by the SSE reconciler; the envelope snapshot only needs
      non-negative seq).
    * At most one ``summary`` block per envelope.
    * At most one ``sources`` block per envelope.
    * Total block count ≤ :data:`MAX_BLOCKS`.
    * Any block whose ``state`` is :attr:`BlockState.failed` has a
      non-empty ``reason``.

    Args:
        envelope: The envelope to validate.

    Raises:
        EnvelopeValidationError: On the first rule violation found.
            The message names the specific rule.
    """
    blocks = envelope.blocks
    if len(blocks) > MAX_BLOCKS:
        raise EnvelopeValidationError(
            f"envelope has {len(blocks)} blocks; cap is {MAX_BLOCKS}"
        )

    seen_ids: set[str] = set()
    summary_count = 0
    sources_count = 0
    for block in blocks:
        if block.id in seen_ids:
            raise EnvelopeValidationError(f"duplicate block id: {block.id!r}")
        seen_ids.add(block.id)

        if block.seq < 0:
            raise EnvelopeValidationError(
                f"block {block.id!r} has negative seq {block.seq}"
            )

        if block.type is BlockType.summary:
            summary_count += 1
            if summary_count > 1:
                raise EnvelopeValidationError(
                    "envelope contains more than one summary block"
                )
        elif block.type is BlockType.sources:
            sources_count += 1
            if sources_count > 1:
                raise EnvelopeValidationError(
                    "envelope contains more than one sources block"
                )

        if block.state is BlockState.failed and not block.reason:
            raise EnvelopeValidationError(
                f"block {block.id!r} is failed but has no reason"
            )


__all__ = [
    "EnvelopeMode",
    "EnvelopeStatus",
    "EnvelopeValidationError",
    "Hero",
    "MAX_BLOCKS",
    "ResponseEnvelope",
    "validate_envelope",
]
