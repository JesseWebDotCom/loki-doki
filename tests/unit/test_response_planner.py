"""Tests for :mod:`lokidoki.orchestrator.response.planner` and the
chunk-7 envelope persistence round-trip.

Chunk 12 replaced the minimal chunk-7 planner with mode-aware block
allocation (``direct`` / ``standard`` / ``rich`` / ``deep`` /
``search`` / ``artifact``). The block-family assertions here track
the new contract; per-mode coverage lives in ``test_response_mode``.

The persistence round-trip test writes a serialized envelope through
``MemoryProvider.add_message`` and reads it back raw from the
``messages.response_envelope`` column, then confirms
``envelope_from_dict`` yields an equal :class:`ResponseEnvelope`.
"""
from __future__ import annotations

import json

import pytest

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.response import (
    Block,
    BlockState,
    BlockType,
    Hero,
    ResponseEnvelope,
    envelope_from_dict,
    envelope_to_dict,
)
from lokidoki.orchestrator.response.planner import plan_initial_blocks


# ---------------------------------------------------------------------------
# Planner — default (``standard``) mode shape
# ---------------------------------------------------------------------------


def test_planner_standard_emits_summary_and_follow_ups_when_no_adapter_outputs() -> None:
    blocks = plan_initial_blocks([])

    assert [b.id for b in blocks] == ["summary", "follow_ups"]
    assert blocks[0].type is BlockType.summary
    assert blocks[0].state is BlockState.loading
    assert blocks[0].seq == 0


def test_planner_standard_emits_summary_when_adapter_outputs_are_empty() -> None:
    blocks = plan_initial_blocks([AdapterOutput(), AdapterOutput()])

    assert [b.id for b in blocks] == ["summary", "follow_ups"]


def test_planner_ignores_none_entries() -> None:
    blocks = plan_initial_blocks([None, AdapterOutput(), None])

    assert [b.id for b in blocks] == ["summary", "follow_ups"]


def test_planner_standard_adds_sources_block_when_any_output_has_sources() -> None:
    outputs = [
        AdapterOutput(),
        AdapterOutput(
            sources=(Source(title="Wookieepedia", url="file:///offline/wp.html"),),
        ),
    ]

    blocks = plan_initial_blocks(outputs)

    ids = [b.id for b in blocks]
    assert ids == ["summary", "sources", "follow_ups"]
    assert blocks[1].type is BlockType.sources
    assert blocks[1].state is BlockState.loading


def test_planner_standard_adds_media_block_when_any_output_has_media() -> None:
    outputs = [
        AdapterOutput(media=({"kind": "video", "url": "file:///offline/luke.mp4"},)),
    ]

    blocks = plan_initial_blocks(outputs)

    ids = [b.id for b in blocks]
    assert ids == ["summary", "media", "follow_ups"]
    assert blocks[1].type is BlockType.media


def test_planner_standard_emits_all_three_when_many_outputs_contribute() -> None:
    outputs = [
        AdapterOutput(
            sources=(Source(title="Padme dossier", url="file:///offline/padme.html"),),
        ),
        AdapterOutput(
            media=({"kind": "image", "url": "/assets/naboo.png"},),
        ),
        AdapterOutput(
            sources=(Source(title="Luke dossier", url="file:///offline/luke.html"),),
            media=({"kind": "video", "url": "/assets/luke.mp4"},),
        ),
    ]

    blocks = plan_initial_blocks(outputs)

    assert [b.id for b in blocks] == ["summary", "sources", "media", "follow_ups"]
    for block in blocks:
        assert block.state is BlockState.loading
        assert block.seq == 0


def test_planner_standard_block_types_within_allowed_families() -> None:
    """Chunk 12's ``standard`` mode emits summary / sources / media / follow_ups.

    Chunks 14 / 15 will add renderer coverage for follow_ups; this
    guard tracks the shape.
    """
    outputs = [
        AdapterOutput(
            sources=(Source(title="Padme", url="file:///offline/padme.html"),),
            media=({"kind": "image", "url": "/assets/padme.png"},),
            facts=("Padme is from Naboo.",),
            follow_up_candidates=("tell me more about Naboo",),
        ),
    ]

    blocks = plan_initial_blocks(outputs)

    allowed = {
        BlockType.summary,
        BlockType.sources,
        BlockType.media,
        BlockType.follow_ups,
    }
    assert all(b.type in allowed for b in blocks)


def test_planner_unknown_mode_falls_back_to_standard() -> None:
    """Any unrecognized mode string drops into ``standard`` — never blows up."""
    blocks = plan_initial_blocks([], mode="gibberish")
    assert [b.id for b in blocks] == ["summary", "follow_ups"]


# ---------------------------------------------------------------------------
# Persistence round-trip — envelope in the messages.response_envelope column
# ---------------------------------------------------------------------------


@pytest.fixture()
def anyio_backend() -> str:
    # asyncio only — trio isn't a runtime target.
    return "asyncio"


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "envelope.db"))
    await mp.initialize()
    try:
        yield mp
    finally:
        await mp.close()


def _sample_envelope() -> ResponseEnvelope:
    return ResponseEnvelope(
        request_id="req_padme_1",
        mode="standard",
        status="complete",
        hero=Hero(title="Padme Amidala", subtitle="Senator of Naboo"),
        blocks=[
            Block(
                id="summary",
                type=BlockType.summary,
                state=BlockState.ready,
                seq=3,
                content="Padme Amidala was queen and senator of Naboo.",
            ),
            Block(
                id="sources",
                type=BlockType.sources,
                state=BlockState.ready,
                seq=1,
                items=[
                    {"title": "Wookieepedia", "url": "file:///offline/padme.html"},
                ],
            ),
        ],
        source_surface=[
            {"title": "Wookieepedia", "url": "file:///offline/padme.html"},
        ],
        spoken_text="Padme was a senator from Naboo.",
    )


@pytest.mark.anyio
async def test_envelope_persists_round_trip(memory):
    """End-to-end: serialize, write, read raw, deserialize — equal to source."""
    uid = await memory.get_or_create_user("luke")
    sid = await memory.create_session(uid, "envelope round-trip")

    envelope = _sample_envelope()
    envelope_json = json.dumps(envelope_to_dict(envelope), separators=(",", ":"))

    message_id = await memory.add_message(
        user_id=uid,
        session_id=sid,
        role="assistant",
        content="Padme was queen and senator of Naboo.",
        response_envelope=envelope_json,
    )

    row = await memory.run_sync(
        lambda conn: conn.execute(
            "SELECT response_envelope FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
    )
    assert row is not None
    stored = row["response_envelope"]
    assert stored is not None
    restored = envelope_from_dict(json.loads(stored))
    assert restored == envelope


@pytest.mark.anyio
async def test_add_message_without_envelope_leaves_column_null(memory):
    """Legacy call path (no ``response_envelope``) still works.

    Ensures the migration keeps old writers compatible.
    """
    uid = await memory.get_or_create_user("leia")
    sid = await memory.create_session(uid, "legacy compat")

    message_id = await memory.add_message(
        user_id=uid,
        session_id=sid,
        role="assistant",
        content="Help me, Obi-Wan Kenobi.",
    )

    row = await memory.run_sync(
        lambda conn: conn.execute(
            "SELECT response_envelope FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
    )
    assert row is not None
    assert row["response_envelope"] is None
