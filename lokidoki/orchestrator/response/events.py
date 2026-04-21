"""Event constructors for the rich-response SSE family.

Chunk 9 of the rich-response rollout (see
``docs/rich-response/chunk-9-response-events.md``).

These helpers build :class:`SSEEvent` instances for the new
response-composition event family. The names and shapes follow design
§11.5 / §13 so the backend and frontend share one contract:

* ``response_init``      — open the envelope, announce ``mode`` + planned ``blocks``.
* ``block_init``         — announce a single block (one event per planned block).
* ``block_patch``        — incremental content update (``delta`` for prose,
  ``items_delta`` for list blocks); carries a monotonically-increasing
  ``seq`` scoped to ``block_id``.
* ``block_ready``        — block has reached its final state.
* ``block_failed``       — block failed; ``reason`` is a short human string.
* ``source_add``         — append one source to the source surface.
* ``media_add``          — append one media card to the media block.
* ``response_snapshot``  — canonical serialized envelope for reconciliation.
* ``response_done``      — terminal event for the turn.

Additive only — these events do not collide with the existing
pipeline-phase events (``decomposition`` / ``routing`` / ``synthesis``
/ ``augmentation`` / ``micro_fast_lane``). Transport is the same
``SSEEvent`` wire shape, so the existing frontend SSE parser continues
to work; chunk 10 wires the frontend to the new names.
"""
from __future__ import annotations

from typing import Any

from lokidoki.orchestrator.core.streaming import SSEEvent
from lokidoki.orchestrator.response.blocks import Block
from lokidoki.orchestrator.response.envelope import ResponseEnvelope
from lokidoki.orchestrator.response.serde import block_to_dict, envelope_to_dict


# ---- event names -------------------------------------------------------
#
# Exported as module constants so both the emitter (pipeline phases) and
# the consumer (tests, chunk 10's frontend) can reference one source of
# truth. The string values match the spec in the chunk doc.

RESPONSE_INIT = "response_init"
BLOCK_INIT = "block_init"
BLOCK_PATCH = "block_patch"
BLOCK_READY = "block_ready"
BLOCK_FAILED = "block_failed"
SOURCE_ADD = "source_add"
MEDIA_ADD = "media_add"
RESPONSE_SNAPSHOT = "response_snapshot"
RESPONSE_DONE = "response_done"


# ---- event constructors -----------------------------------------------


def response_init(request_id: str, mode: str, blocks: list[Block]) -> SSEEvent:
    """Build the ``response_init`` event opening the envelope.

    Carries the per-block ``id`` / ``type`` pair so the frontend can
    pre-allocate block slots in the planned order before any content
    has landed.
    """
    block_stubs = [{"id": b.id, "type": b.type.value} for b in blocks]
    return SSEEvent(
        phase=RESPONSE_INIT,
        status="data",
        data={"request_id": request_id, "mode": mode, "blocks": block_stubs},
    )


def block_init(block: Block) -> SSEEvent:
    """Announce a single planned block in ``state=loading``."""
    return SSEEvent(
        phase=BLOCK_INIT,
        status="data",
        data={
            "block_id": block.id,
            "type": block.type.value,
            "state": "loading",
        },
    )


def block_patch(
    block_id: str,
    seq: int,
    *,
    delta: str | None = None,
    items_delta: list[dict[str, Any]] | None = None,
) -> SSEEvent:
    """Emit an incremental update for a block.

    Exactly one of ``delta`` (prose) or ``items_delta`` (list of dicts)
    is typical; both may be ``None`` for a heartbeat, but callers
    should avoid that. ``seq`` MUST monotonically increase within a
    given ``block_id`` so the frontend / persistence can dedupe replays.
    """
    data: dict[str, Any] = {"block_id": block_id, "seq": int(seq)}
    if delta is not None:
        data["delta"] = delta
    if items_delta is not None:
        data["items_delta"] = list(items_delta)
    return SSEEvent(phase=BLOCK_PATCH, status="data", data=data)


def block_ready(block_id: str) -> SSEEvent:
    """Mark a block as finalized."""
    return SSEEvent(
        phase=BLOCK_READY,
        status="data",
        data={"block_id": block_id},
    )


def block_failed(block_id: str, reason: str) -> SSEEvent:
    """Mark a block as failed with a short human-readable reason."""
    return SSEEvent(
        phase=BLOCK_FAILED,
        status="data",
        data={"block_id": block_id, "reason": reason or "unknown"},
    )


def source_add(source: dict[str, Any]) -> SSEEvent:
    """Append one serialized source to the shared source surface."""
    return SSEEvent(
        phase=SOURCE_ADD,
        status="data",
        data={"source": dict(source)},
    )


def media_add(media: dict[str, Any]) -> SSEEvent:
    """Append one media card to the media block."""
    return SSEEvent(
        phase=MEDIA_ADD,
        status="data",
        data={"media": dict(media)},
    )


def response_snapshot(envelope: ResponseEnvelope) -> SSEEvent:
    """Emit the canonical serialized envelope for reconciliation."""
    return SSEEvent(
        phase=RESPONSE_SNAPSHOT,
        status="data",
        data={"envelope": envelope_to_dict(envelope)},
    )


def response_done(request_id: str, status: str) -> SSEEvent:
    """Terminal event for the turn.

    ``status`` is one of ``"complete"`` / ``"failed"`` (mirrors the
    envelope's own status enum minus the transient ``"streaming"``).
    """
    return SSEEvent(
        phase=RESPONSE_DONE,
        status="data",
        data={"request_id": request_id, "status": status},
    )


# Re-export :func:`block_to_dict` so callers importing from this module
# don't have to reach into serde directly for the odd bespoke emit
# site (e.g. chunk 10's history replay).
__all__ = [
    "RESPONSE_INIT",
    "BLOCK_INIT",
    "BLOCK_PATCH",
    "BLOCK_READY",
    "BLOCK_FAILED",
    "SOURCE_ADD",
    "MEDIA_ADD",
    "RESPONSE_SNAPSHOT",
    "RESPONSE_DONE",
    "response_init",
    "block_init",
    "block_patch",
    "block_ready",
    "block_failed",
    "source_add",
    "media_add",
    "response_snapshot",
    "response_done",
    "block_to_dict",
]
