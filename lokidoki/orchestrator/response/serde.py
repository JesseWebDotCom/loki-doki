"""JSON-compatible serde for :class:`ResponseEnvelope`.

Used by two call sites (once chunk 7 lands):

* SSE transport — ``response_snapshot`` event carries the envelope as
  a JSON object; ``block_init`` / ``block_patch`` / ``block_ready``
  events carry a single serialized :class:`Block` via
  :func:`block_to_dict` / :func:`block_from_dict`.
* SQLite persistence — the canonical reconciled envelope is stored on
  the assistant message row so history replay is an O(1) load rather
  than an SSE re-stream.

Round-trip invariant: ``envelope_from_dict(envelope_to_dict(e)) == e``
for every :class:`BlockType`. Unknown block types raise ``ValueError``
rather than silently dropping — forward-compat is chunk 7's concern,
not this one's.
"""
from __future__ import annotations

from typing import Any, get_args

from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import (
    EnvelopeMode,
    EnvelopeStatus,
    Hero,
    ResponseEnvelope,
)

_VALID_MODES: frozenset[str] = frozenset(get_args(EnvelopeMode))
_VALID_STATUSES: frozenset[str] = frozenset(get_args(EnvelopeStatus))


def block_to_dict(block: Block) -> dict[str, Any]:
    """Serialize a single :class:`Block` to a JSON-compatible dict.

    Only populated payload fields are emitted so the wire shape stays
    tight — a ``summary`` block does not carry a ``null`` ``items``.
    """
    data: dict[str, Any] = {
        "id": block.id,
        "type": block.type.value,
        "state": block.state.value,
        "seq": block.seq,
    }
    if block.reason is not None:
        data["reason"] = block.reason
    if block.content is not None:
        data["content"] = block.content
    if block.items is not None:
        data["items"] = list(block.items)
    if block.comparison is not None:
        data["comparison"] = dict(block.comparison)
    return data


def block_from_dict(data: dict[str, Any]) -> Block:
    """Inverse of :func:`block_to_dict`.

    Raises:
        ValueError: If ``type`` or ``state`` are not recognized.
        KeyError: If the required ``id`` / ``type`` keys are missing.
    """
    raw_type = data["type"]
    try:
        block_type = BlockType(raw_type)
    except ValueError as exc:  # unknown block family
        raise ValueError(f"unknown block type: {raw_type!r}") from exc

    raw_state = data.get("state", BlockState.loading.value)
    try:
        block_state = BlockState(raw_state)
    except ValueError as exc:
        raise ValueError(f"unknown block state: {raw_state!r}") from exc

    return Block(
        id=data["id"],
        type=block_type,
        state=block_state,
        seq=int(data.get("seq", 0)),
        reason=data.get("reason"),
        content=data.get("content"),
        items=list(data["items"]) if "items" in data else None,
        comparison=dict(data["comparison"]) if "comparison" in data else None,
    )


def _hero_to_dict(hero: Hero) -> dict[str, Any]:
    data: dict[str, Any] = {"title": hero.title}
    if hero.subtitle is not None:
        data["subtitle"] = hero.subtitle
    if hero.image_url is not None:
        data["image_url"] = hero.image_url
    return data


def _hero_from_dict(data: dict[str, Any]) -> Hero:
    return Hero(
        title=data["title"],
        subtitle=data.get("subtitle"),
        image_url=data.get("image_url"),
    )


def envelope_to_dict(envelope: ResponseEnvelope) -> dict[str, Any]:
    """Serialize a :class:`ResponseEnvelope` to a JSON-compatible dict.

    Omits ``None`` / empty collections to keep the wire shape minimal;
    :func:`envelope_from_dict` restores the defaults.
    """
    data: dict[str, Any] = {
        "request_id": envelope.request_id,
        "mode": envelope.mode,
        "status": envelope.status,
        "blocks": [block_to_dict(block) for block in envelope.blocks],
    }
    if envelope.hero is not None:
        data["hero"] = _hero_to_dict(envelope.hero)
    if envelope.source_surface:
        data["source_surface"] = [dict(item) for item in envelope.source_surface]
    if envelope.artifact_surface is not None:
        data["artifact_surface"] = dict(envelope.artifact_surface)
    if envelope.spoken_text is not None:
        data["spoken_text"] = envelope.spoken_text
    if envelope.offline_degraded:
        data["offline_degraded"] = True
    return data


def envelope_from_dict(data: dict[str, Any]) -> ResponseEnvelope:
    """Inverse of :func:`envelope_to_dict`.

    Raises:
        ValueError: If ``mode``, ``status``, or any block has an
            unrecognized discriminator.
        KeyError: If the required ``request_id`` field is missing.
    """
    mode = data.get("mode", "standard")
    if mode not in _VALID_MODES:
        raise ValueError(f"unknown envelope mode: {mode!r}")
    status = data.get("status", "streaming")
    if status not in _VALID_STATUSES:
        raise ValueError(f"unknown envelope status: {status!r}")

    hero_raw = data.get("hero")
    hero = _hero_from_dict(hero_raw) if hero_raw is not None else None

    blocks_raw = data.get("blocks", [])
    blocks = [block_from_dict(block) for block in blocks_raw]

    source_surface_raw = data.get("source_surface", [])
    source_surface = [dict(item) for item in source_surface_raw]

    artifact_raw = data.get("artifact_surface")
    artifact_surface = dict(artifact_raw) if artifact_raw is not None else None

    return ResponseEnvelope(
        request_id=data["request_id"],
        mode=mode,
        status=status,
        hero=hero,
        blocks=blocks,
        source_surface=source_surface,
        artifact_surface=artifact_surface,
        spoken_text=data.get("spoken_text"),
        offline_degraded=bool(data.get("offline_degraded", False)),
    )


__all__ = [
    "block_from_dict",
    "block_to_dict",
    "envelope_from_dict",
    "envelope_to_dict",
]
