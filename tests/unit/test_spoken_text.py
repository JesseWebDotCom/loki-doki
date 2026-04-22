"""Tests for voice-parity resolution (chunk 16).

Covers three contracts from ``docs/rich-response/chunk-16-voice-parity.md``:

1. :func:`resolve_spoken_text` prefers ``envelope.spoken_text`` when
   populated, falls back to the summary block trimmed at a sentence
   boundary, and returns ``""`` when neither is available.
2. The fallback NEVER concatenates source / media / follow-up items
   into the spoken output — only summary / clarification prose is
   eligible (design §20.2).
3. The one-call synthesis contract — the combine + direct_chat
   prompts instruct the LLM to append a ``<spoken_text>...</spoken_text>``
   island, and :func:`extract_and_strip_spoken_text` parses that
   island, strips it from the visible reply, and threads the value
   onto :class:`ResponseObject.spoken_text`. No second LLM call.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.types import ResponseObject
from lokidoki.orchestrator.fallbacks.llm_prompt_builder import (
    SPOKEN_TEXT_MAX_CHARS,
    extract_and_strip_spoken_text,
)
from lokidoki.orchestrator.fallbacks.prompts import (
    COMBINE_PROMPT,
    DIRECT_CHAT_PROMPT,
)
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import ResponseEnvelope
from lokidoki.orchestrator.response.planner import TTS_POLICY, tts_policy_for
from lokidoki.orchestrator.response.spoken import resolve_spoken_text


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _summary(content: str, state: BlockState = BlockState.ready) -> Block:
    return Block(id="summary", type=BlockType.summary, state=state, seq=1, content=content)


def _sources_block(items: list[dict]) -> Block:
    return Block(id="sources", type=BlockType.sources, state=BlockState.ready, seq=1, items=items)


def _media_block(items: list[dict]) -> Block:
    return Block(id="media", type=BlockType.media, state=BlockState.ready, seq=1, items=items)


def _follow_ups_block(items: list[dict]) -> Block:
    return Block(id="follow_ups", type=BlockType.follow_ups, state=BlockState.ready, seq=1, items=items)


# ---------------------------------------------------------------------------
# resolve_spoken_text — priority rules
# ---------------------------------------------------------------------------


class TestResolveSpokenTextPriority:
    def test_explicit_spoken_text_wins(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req1",
            blocks=[_summary("Luke is on Tatooine looking for Obi-Wan Kenobi.")],
            spoken_text="Luke heads out.",
        )
        assert resolve_spoken_text(envelope) == "Luke heads out."

    def test_empty_spoken_text_falls_back_to_summary(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req2",
            blocks=[_summary("Yoda is training on Dagobah.")],
            spoken_text="",
        )
        assert resolve_spoken_text(envelope) == "Yoda is training on Dagobah."

    def test_none_spoken_text_falls_back_to_summary(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req3",
            blocks=[_summary("Leia sends the plans to Obi-Wan.")],
            spoken_text=None,
        )
        assert resolve_spoken_text(envelope) == "Leia sends the plans to Obi-Wan."

    def test_whitespace_only_spoken_text_falls_back(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req4",
            blocks=[_summary("Padme is a senator from Naboo.")],
            spoken_text="   \n\t ",
        )
        assert resolve_spoken_text(envelope) == "Padme is a senator from Naboo."

    def test_no_summary_and_no_spoken_text_returns_empty(self) -> None:
        envelope = ResponseEnvelope(request_id="req5", blocks=[])
        assert resolve_spoken_text(envelope) == ""

    def test_loading_summary_returns_empty(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req6",
            blocks=[_summary("", state=BlockState.loading)],
        )
        assert resolve_spoken_text(envelope) == ""

    def test_failed_summary_returns_empty(self) -> None:
        envelope = ResponseEnvelope(
            request_id="req7",
            blocks=[
                Block(
                    id="summary",
                    type=BlockType.summary,
                    state=BlockState.failed,
                    seq=0,
                    reason="timeout",
                ),
            ],
        )
        assert resolve_spoken_text(envelope) == ""


# ---------------------------------------------------------------------------
# resolve_spoken_text — fallback trimming
# ---------------------------------------------------------------------------


class TestResolveSpokenTextFallbackTrimming:
    def test_trims_to_sentence_boundary_under_200_chars(self) -> None:
        summary = (
            "Anakin Skywalker is a Jedi Knight from Tatooine. "
            "He piloted a Naboo starfighter at the Battle of Naboo. "
            "He married Padme Amidala in secret on Naboo shortly after the Clone Wars began. "
            "He later turned to the dark side and took the name Darth Vader."
        )
        envelope = ResponseEnvelope(request_id="rt", blocks=[_summary(summary)])
        out = resolve_spoken_text(envelope)
        assert len(out) <= 200
        # Must land on a sentence terminator.
        assert out.endswith((".", "!", "?"))

    def test_short_summary_passes_through_whole(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rt2",
            blocks=[_summary("It is a short answer.")],
        )
        assert resolve_spoken_text(envelope) == "It is a short answer."

    def test_strips_markdown_citation_markers(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rt3",
            blocks=[_summary("**Luke** is from Tatooine [src:1].")],
        )
        out = resolve_spoken_text(envelope)
        assert "[src:" not in out
        assert "**" not in out
        assert "Luke is from Tatooine" in out

    def test_strips_markdown_links(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rt4",
            blocks=[_summary("See [the docs](https://example/docs) for more.")],
        )
        out = resolve_spoken_text(envelope)
        assert "https://" not in out
        assert "the docs" in out


# ---------------------------------------------------------------------------
# No block items ever leak into the spoken form
# ---------------------------------------------------------------------------


class TestResolveSpokenTextNeverSpeaksBlockItems:
    def test_sources_block_is_never_spoken(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rs1",
            blocks=[
                _summary(""),
                _sources_block([
                    {"title": "Wookieepedia", "url": "https://starwars.fandom.com/wiki/Naboo"},
                    {"title": "Naboo Archives", "url": "https://example.test/naboo"},
                ]),
            ],
        )
        # summary is empty + loading was replaced with ready with "" —
        # cleaner for the fallback to simply return empty rather than
        # picking up a URL. This guarantees no URL ever reaches TTS.
        envelope.blocks[0].state = BlockState.ready
        envelope.blocks[0].content = ""
        out = resolve_spoken_text(envelope)
        assert "http" not in out
        assert "Wookieepedia" not in out

    def test_media_block_is_never_spoken(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rs2",
            blocks=[
                _summary("Here is a clip."),
                _media_block([
                    {"kind": "youtube_video", "title": "Naboo Tour", "url": "https://y/1"},
                ]),
            ],
        )
        out = resolve_spoken_text(envelope)
        assert "Naboo Tour" not in out
        assert "https://" not in out

    def test_follow_ups_block_is_never_spoken(self) -> None:
        envelope = ResponseEnvelope(
            request_id="rs3",
            blocks=[
                _summary("Padme is from Naboo."),
                _follow_ups_block([
                    {"text": "ask about Anakin"},
                    {"text": "ask about Obi-Wan"},
                ]),
            ],
        )
        out = resolve_spoken_text(envelope)
        assert out == "Padme is from Naboo."
        assert "ask about" not in out


# ---------------------------------------------------------------------------
# One-call synthesis contract (prompt + extractor)
# ---------------------------------------------------------------------------


class TestSynthesisOneCallContract:
    def test_combine_prompt_requires_spoken_text_island(self) -> None:
        assert "<spoken_text>" in COMBINE_PROMPT
        assert "</spoken_text>" in COMBINE_PROMPT
        # "one pass" / "same JSON call" — guard the intent so a later
        # refactor doesn't silently split into two LLM calls.
        assert "same JSON call" in COMBINE_PROMPT
        assert "never a second pass" in COMBINE_PROMPT

    def test_direct_chat_prompt_requires_spoken_text_island(self) -> None:
        assert "<spoken_text>" in DIRECT_CHAT_PROMPT
        assert "</spoken_text>" in DIRECT_CHAT_PROMPT
        assert "same JSON call" in DIRECT_CHAT_PROMPT

    def test_extract_pulls_island_and_strips_from_reply(self) -> None:
        raw = (
            "Luke is from Tatooine. He found the droids in the desert.\n"
            "<spoken_text>Luke finds the droids on Tatooine.</spoken_text>"
        )
        cleaned, spoken = extract_and_strip_spoken_text(raw)
        assert spoken == "Luke finds the droids on Tatooine."
        assert "<spoken_text>" not in cleaned
        assert "Luke is from Tatooine." in cleaned

    def test_extract_returns_none_when_island_absent(self) -> None:
        raw = "No islands here, just prose."
        cleaned, spoken = extract_and_strip_spoken_text(raw)
        assert spoken is None
        assert cleaned == raw

    def test_extract_caps_long_spoken_text(self) -> None:
        spoken_body = "x" * (SPOKEN_TEXT_MAX_CHARS + 50)
        raw = f"reply\n<spoken_text>{spoken_body}</spoken_text>"
        _, spoken = extract_and_strip_spoken_text(raw)
        assert spoken is not None
        assert len(spoken) <= SPOKEN_TEXT_MAX_CHARS

    def test_extract_takes_last_island_when_multiple(self) -> None:
        raw = (
            "reply one\n<spoken_text>first</spoken_text>\n"
            "reply two\n<spoken_text>final paraphrase</spoken_text>"
        )
        cleaned, spoken = extract_and_strip_spoken_text(raw)
        assert spoken == "final paraphrase"
        # Both islands stripped from the visible reply.
        assert "<spoken_text>" not in cleaned

    def test_empty_island_returns_none(self) -> None:
        raw = "reply\n<spoken_text>   </spoken_text>"
        cleaned, spoken = extract_and_strip_spoken_text(raw)
        assert spoken is None
        assert "<spoken_text>" not in cleaned

    def test_response_object_carries_spoken_text_field(self) -> None:
        # The dataclass must expose the field so the single-call
        # contract survives the round-trip from llm_client to the
        # envelope builder.
        obj = ResponseObject(output_text="hi", spoken_text="hi short")
        assert obj.spoken_text == "hi short"


# ---------------------------------------------------------------------------
# TTS policy table
# ---------------------------------------------------------------------------


class TestTtsPolicyTable:
    def test_summary_is_speak(self) -> None:
        assert tts_policy_for(BlockType.summary) == "speak"

    def test_clarification_is_speak(self) -> None:
        assert tts_policy_for(BlockType.clarification) == "speak"

    @pytest.mark.parametrize(
        "block_type",
        [
            BlockType.key_facts,
            BlockType.steps,
            BlockType.comparison,
            BlockType.sources,
            BlockType.media,
            BlockType.cta_links,
            BlockType.follow_ups,
        ],
    )
    def test_visual_only_blocks_are_skip(self, block_type: BlockType) -> None:
        assert tts_policy_for(block_type) == "skip"

    def test_status_is_speak_but_throttled_on_client(self) -> None:
        # The backend table says "speak"; the throttle (>3s, ≤1/phase)
        # lives on the frontend. Both halves of the contract must
        # agree — this test guards the backend half.
        assert tts_policy_for(BlockType.status) == "speak"

    def test_every_block_type_has_a_policy(self) -> None:
        for block_type in BlockType:
            assert block_type in TTS_POLICY, (
                f"BlockType {block_type} missing from TTS_POLICY — "
                "new block families require a conscious read/skip decision."
            )
