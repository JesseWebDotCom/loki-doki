"""Tests for the :mod:`lokidoki.orchestrator.response` types (chunk 6).

Covers:

* :func:`validate_envelope` structural invariants (unique ids, block
  count cap, single summary/sources, failed-requires-reason, seq
  monotonicity on the snapshot).
* Round-trip serde for every :class:`BlockType`.
* ``envelope_from_dict`` rejects unknown block types with
  ``ValueError`` instead of silently dropping them.

No consumer wiring is tested here — chunk 7 plumbs the envelope
through synthesis and will add pipeline-level tests.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.response import (
    Block,
    BlockState,
    BlockType,
    EnvelopeValidationError,
    Hero,
    ResponseEnvelope,
    envelope_from_dict,
    envelope_to_dict,
    validate_envelope,
)
from lokidoki.orchestrator.response.envelope import MAX_BLOCKS
from lokidoki.orchestrator.response.serde import block_from_dict, block_to_dict


# ---------------------------------------------------------------------------
# validate_envelope — happy path + each rule violation
# ---------------------------------------------------------------------------


def _summary_block(**overrides) -> Block:
    defaults = {
        "id": "summary",
        "type": BlockType.summary,
        "state": BlockState.ready,
        "seq": 3,
        "content": "Padme is a senator from Naboo.",
    }
    defaults.update(overrides)
    return Block(**defaults)


def _sources_block(**overrides) -> Block:
    defaults = {
        "id": "sources",
        "type": BlockType.sources,
        "state": BlockState.ready,
        "seq": 1,
        "items": [{"title": "Wookieepedia", "url": "file:///offline/wp.html"}],
    }
    defaults.update(overrides)
    return Block(**defaults)


def _media_block(**overrides) -> Block:
    defaults = {
        "id": "media",
        "type": BlockType.media,
        "state": BlockState.ready,
        "seq": 1,
        "items": [{"kind": "image", "src": "/assets/luke.png"}],
    }
    defaults.update(overrides)
    return Block(**defaults)


def test_validate_envelope_accepts_summary_sources_media() -> None:
    envelope = ResponseEnvelope(
        request_id="req_luke_1",
        mode="standard",
        status="complete",
        hero=Hero(title="Luke Skywalker", subtitle="Jedi Knight"),
        blocks=[_summary_block(), _sources_block(), _media_block()],
    )

    # Does not raise.
    validate_envelope(envelope)


def test_validate_envelope_rejects_two_summary_blocks() -> None:
    envelope = ResponseEnvelope(
        request_id="req_anakin_1",
        blocks=[
            _summary_block(id="summary"),
            _summary_block(id="summary-2", content="Another summary."),
        ],
    )

    with pytest.raises(EnvelopeValidationError, match="more than one summary"):
        validate_envelope(envelope)


def test_validate_envelope_rejects_two_sources_blocks() -> None:
    envelope = ResponseEnvelope(
        request_id="req_leia_1",
        blocks=[
            _sources_block(id="sources"),
            _sources_block(id="sources-2"),
        ],
    )

    with pytest.raises(EnvelopeValidationError, match="more than one sources"):
        validate_envelope(envelope)


def test_validate_envelope_rejects_too_many_blocks() -> None:
    # Build MAX_BLOCKS + 1 unique, non-summary, non-sources blocks.
    blocks = [
        Block(
            id=f"follow-ups-{index}",
            type=BlockType.follow_ups,
            state=BlockState.ready,
            seq=0,
            items=[{"label": f"Option {index}"}],
        )
        for index in range(MAX_BLOCKS + 1)
    ]
    envelope = ResponseEnvelope(request_id="req_padme_1", blocks=blocks)

    with pytest.raises(EnvelopeValidationError, match="cap is"):
        validate_envelope(envelope)


def test_validate_envelope_rejects_duplicate_block_ids() -> None:
    envelope = ResponseEnvelope(
        request_id="req_han_1",
        blocks=[
            _media_block(id="dup"),
            Block(
                id="dup",
                type=BlockType.follow_ups,
                state=BlockState.ready,
                seq=0,
                items=[{"label": "Ask again"}],
            ),
        ],
    )

    with pytest.raises(EnvelopeValidationError, match="duplicate block id"):
        validate_envelope(envelope)


def test_validate_envelope_rejects_negative_seq() -> None:
    # A negative seq cannot be reached by a well-behaved reconciler; seq
    # is the monotonically increasing patch counter, so "non-monotonic"
    # at snapshot time collapses to "negative."
    envelope = ResponseEnvelope(
        request_id="req_yoda_1",
        blocks=[_summary_block(seq=-1)],
    )

    with pytest.raises(EnvelopeValidationError, match="negative seq"):
        validate_envelope(envelope)


def test_validate_envelope_failed_requires_reason() -> None:
    envelope = ResponseEnvelope(
        request_id="req_chewie_1",
        blocks=[
            Block(
                id="summary",
                type=BlockType.summary,
                state=BlockState.failed,
                seq=0,
                reason=None,
            ),
        ],
    )

    with pytest.raises(EnvelopeValidationError, match="failed but has no reason"):
        validate_envelope(envelope)


def test_validate_envelope_failed_with_reason_is_ok() -> None:
    envelope = ResponseEnvelope(
        request_id="req_chewie_2",
        blocks=[
            Block(
                id="summary",
                type=BlockType.summary,
                state=BlockState.failed,
                seq=0,
                reason="skill timeout",
            ),
        ],
    )

    # Does not raise.
    validate_envelope(envelope)


# ---------------------------------------------------------------------------
# serde — round-trip every BlockType + reject unknown types
# ---------------------------------------------------------------------------


def _block_for_type(block_type: BlockType) -> Block:
    """Construct a representative block of each family for round-tripping."""
    base = {
        "id": f"{block_type.value}-rt",
        "type": block_type,
        "state": BlockState.ready,
        "seq": 2,
    }
    if block_type in {BlockType.summary, BlockType.clarification, BlockType.status}:
        return Block(**base, content=f"example {block_type.value} prose")
    if block_type is BlockType.comparison:
        return Block(
            **base,
            comparison={
                "left": {"name": "Luke"},
                "right": {"name": "Leia"},
                "dimensions": ["lightsaber", "homeworld"],
            },
        )
    # All remaining block families use items.
    return Block(**base, items=[{"label": f"{block_type.value}-item-0"}])


@pytest.mark.parametrize("block_type", list(BlockType))
def test_block_round_trip_for_every_type(block_type: BlockType) -> None:
    block = _block_for_type(block_type)
    restored = block_from_dict(block_to_dict(block))
    assert restored == block


def test_envelope_round_trip_covers_every_block_type() -> None:
    # One envelope that exercises every BlockType (respecting the single
    # summary + single sources constraint).
    blocks = [_block_for_type(bt) for bt in BlockType]
    # Cap is 8; BlockType now has 11 members after chunk 20 added
    # ``artifact_preview``. Drop three low-value families for the
    # for the envelope-level round-trip while still testing each block
    # type individually via block_round_trip_for_every_type above.
    blocks = [
        b
        for b in blocks
        if b.type
        not in {BlockType.cta_links, BlockType.follow_ups, BlockType.status}
    ]

    envelope = ResponseEnvelope(
        request_id="req_rt_1",
        mode="rich",
        status="complete",
        hero=Hero(
            title="Naboo",
            subtitle="Capital: Theed",
            image_url="/assets/naboo.png",
        ),
        blocks=blocks,
        source_surface=[
            {"title": "Wookieepedia", "url": "file:///offline/naboo.html"},
        ],
        artifact_surface=None,
        spoken_text="Naboo is a planet in the Chommell sector.",
    )
    validate_envelope(envelope)

    restored = envelope_from_dict(envelope_to_dict(envelope))
    assert restored == envelope


def test_envelope_round_trip_minimal_shape() -> None:
    envelope = ResponseEnvelope(request_id="req_min_1")
    restored = envelope_from_dict(envelope_to_dict(envelope))
    assert restored == envelope


def test_envelope_from_dict_rejects_unknown_block_type() -> None:
    payload = {
        "request_id": "req_bad_1",
        "mode": "standard",
        "status": "streaming",
        "blocks": [
            {
                "id": "summary",
                "type": "summary",
                "state": "ready",
                "seq": 0,
                "content": "ok",
            },
            {
                "id": "rogue",
                "type": "not_a_real_type",
                "state": "ready",
                "seq": 0,
            },
        ],
    }

    with pytest.raises(ValueError, match="unknown block type"):
        envelope_from_dict(payload)


def test_envelope_from_dict_rejects_unknown_mode() -> None:
    payload = {
        "request_id": "req_bad_mode",
        "mode": "telepathy",
        "status": "streaming",
        "blocks": [],
    }

    with pytest.raises(ValueError, match="unknown envelope mode"):
        envelope_from_dict(payload)


def test_envelope_from_dict_rejects_unknown_status() -> None:
    payload = {
        "request_id": "req_bad_status",
        "mode": "standard",
        "status": "finished-ish",
        "blocks": [],
    }

    with pytest.raises(ValueError, match="unknown envelope status"):
        envelope_from_dict(payload)
