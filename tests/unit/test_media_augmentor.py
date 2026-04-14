"""Tests for the media augmentor.

Covers three behaviors:

1. YouTube-native primary chunks surface their existing enriched source
   as a MediaCard without re-querying.
2. Non-YouTube eligible chunks trigger a YouTube producer fan-out; each
   successful producer contributes one card.
3. Ineligible capabilities (control_device, etc.) produce no cards.

The YouTube producer entry points (``get_video`` / ``get_music_video``
/ ``get_youtube_channel``) are monkey-patched so the test never hits
the network.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.core.pipeline import _is_deferral_response
from lokidoki.orchestrator.core.types import ExecutionResult, RequestChunk, RouteMatch
from lokidoki.orchestrator.media.augmentor import augment_with_media


def _chunk(idx: int, text: str) -> RequestChunk:
    return RequestChunk(text=text, index=idx, role="primary_request")


def _route(idx: int, capability: str) -> RouteMatch:
    return RouteMatch(chunk_index=idx, capability=capability, confidence=1.0)


def _exec(idx: int, capability: str, *, raw: dict | None = None, success: bool = True) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=success,
        raw_result=raw or {"success": True, "sources": []},
    )


@pytest.mark.anyio
async def test_native_youtube_channel_chunk_surfaces_card():
    """Primary chunk on get_youtube_channel → its enriched source becomes a card."""
    raw = {
        "success": True,
        "sources": [{
            "url": "https://www.youtube.com/@redlettermedia",
            "title": "YouTube Channel - Red Letter Media",
            "type": "channel",
            "channel_name": "Red Letter Media",
            "channel_url": "https://www.youtube.com/@redlettermedia",
            "handle": "@redlettermedia",
            "featured_video_id": "abc123defgh",
        }],
    }
    chunks = [_chunk(0, "red letter media")]
    routes = [_route(0, "get_youtube_channel")]
    executions = [_exec(0, "get_youtube_channel", raw=raw)]

    cards = await augment_with_media(chunks, routes, executions)

    assert len(cards) == 1
    assert cards[0]["kind"] == "youtube_channel"
    assert cards[0]["channel_name"] == "Red Letter Media"
    assert cards[0]["handle"] == "@redlettermedia"
    assert cards[0]["featured_video_id"] == "abc123defgh"


@pytest.mark.anyio
async def test_movie_lookup_fans_out_to_video_producer(monkeypatch):
    """A movie lookup triggers YouTube fan-out for a trailer."""
    async def fake_get_video(payload):
        assert payload["params"]["query"] == "best kubrick movie"
        return {
            "success": True,
            "sources": [{
                "url": "https://www.youtube.com/watch?v=xyz789ijklm",
                "title": "2001: A Space Odyssey Trailer",
                "video_id": "xyz789ijklm",
                "channel": "Warner Bros.",
            }],
        }
    monkeypatch.setattr(
        "lokidoki.orchestrator.skills.youtube.get_video",
        fake_get_video,
    )

    chunks = [_chunk(0, "best kubrick movie")]
    routes = [_route(0, "lookup_movie")]
    executions = [_exec(0, "lookup_movie")]

    cards = await augment_with_media(chunks, routes, executions, raw_text="best kubrick movie")

    assert len(cards) == 1
    assert cards[0]["kind"] == "youtube_video"
    assert cards[0]["video_id"] == "xyz789ijklm"
    assert cards[0]["channel"] == "Warner Bros."


@pytest.mark.anyio
async def test_general_knowledge_chunk_is_not_augmented(monkeypatch):
    """knowledge_query / direct_chat / search_web never trigger media.

    Mirrors ChatGPT: a trailer is NOT the natural answer to 'what causes X'
    or 'tell me about Y'. Media should only accompany requests whose
    *intent* is media (movies, music, TV, explicit YouTube lookups).
    """
    async def boom(payload):  # pragma: no cover - must not fire
        raise AssertionError("general-knowledge turn should not augment")
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", boom)

    for capability in ("direct_chat", "knowledge_query", "search_web", "lookup_fact"):
        text = "what causes youtube to terminate accounts"
        chunks = [_chunk(0, text)]
        routes = [_route(0, capability)]
        executions = [_exec(0, capability)]
        cards = await augment_with_media(chunks, routes, executions, raw_text=text)
        assert cards == [], f"expected no cards for {capability}"


@pytest.mark.anyio
async def test_music_capability_uses_music_video_producer(monkeypatch):
    """play_music routes to get_music_video, not get_video."""
    called = {"video": 0, "music_video": 0}

    async def fake_get_music_video(payload):
        called["music_video"] += 1
        return {
            "success": True,
            "sources": [{
                "url": "https://www.youtube.com/watch?v=mus12345678",
                "title": "Am I Evil",
                "video_id": "mus12345678",
                "channel": "MetallicaVEVO",
                "video_type": "official",
            }],
        }

    async def fake_get_video(payload):  # pragma: no cover - should not fire
        called["video"] += 1
        return {"success": False}

    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_music_video", fake_get_music_video)
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", fake_get_video)

    chunks = [_chunk(0, "am i evil metallica")]
    routes = [_route(0, "play_music")]
    executions = [_exec(0, "play_music")]

    cards = await augment_with_media(chunks, routes, executions)

    assert called == {"video": 0, "music_video": 1}
    assert len(cards) == 1
    assert cards[0]["kind"] == "youtube_video"
    assert cards[0]["video_type"] == "official"


@pytest.mark.anyio
async def test_ineligible_capability_returns_no_cards(monkeypatch):
    """control_device / get_weather must not produce media cards."""
    async def fake_get_video(payload):  # pragma: no cover
        raise AssertionError("should not be called for ineligible capability")
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", fake_get_video)

    chunks = [_chunk(0, "turn off the lights")]
    routes = [_route(0, "control_device")]
    executions = [_exec(0, "control_device")]

    cards = await augment_with_media(chunks, routes, executions)

    assert cards == []


@pytest.mark.anyio
async def test_producer_failure_is_swallowed(monkeypatch):
    """A raising producer must not break the pipeline."""
    async def boom(payload):
        raise RuntimeError("network down")
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", boom)

    chunks = [_chunk(0, "some topic")]
    routes = [_route(0, "knowledge_query")]
    executions = [_exec(0, "knowledge_query")]

    cards = await augment_with_media(chunks, routes, executions)

    assert cards == []


@pytest.mark.anyio
async def test_vague_pronoun_query_is_not_augmented(monkeypatch):
    """Unresolved-subject chunks like 'is it free' must NOT fan out."""
    async def boom(payload):  # pragma: no cover - should not fire
        raise AssertionError("vague pronoun query should be gated out")
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", boom)

    for vague in ["is it free", "what is it", "tell me more", "are they good"]:
        chunks = [_chunk(0, vague)]
        routes = [_route(0, "lookup_movie")]
        executions = [_exec(0, "lookup_movie")]
        cards = await augment_with_media(chunks, routes, executions, raw_text=vague)
        assert cards == [], f"expected no cards for vague query: {vague!r}"


def test_deferral_response_detection():
    """Responses that lead with punt phrases must match the deferral filter."""
    positives = [
        "I'm not sure about the weather today—I'd recommend checking a reliable weather app",
        "I don't know much about that topic.",
        "Could you clarify what you mean by that?",
        "I'm not familiar with that product.",
        "I'd recommend checking a reliable source.",
    ]
    for text in positives:
        assert _is_deferral_response(text), f"expected deferral match for: {text!r}"

    negatives = [
        "Red Letter Media is a film-review group based in Milwaukee.",
        "Stanley Kubrick directed 2001: A Space Odyssey.",
        "Yes, there is a song called Am I Evil.",
        "",
    ]
    for text in negatives:
        assert not _is_deferral_response(text), f"expected non-deferral for: {text!r}"


@pytest.mark.anyio
async def test_raw_text_overrides_poisoned_chunk_text(monkeypatch):
    """When antecedent resolution rewrites chunk.text with a stale
    entity from a prior turn, the augmentor must gate on raw_text
    instead so the cross-turn bleed-through never triggers media.

    Repro: user asks 'is it going to rain today?'. Session state still
    holds 'causes youtube to terminate accounts' as the recent entity,
    so the resolver rewrites the chunk to
    'is causes youtube to terminate accounts going to rain today' —
    which (a) passes the vague-subject gate and (b) would produce a
    totally unrelated YouTube video without this fix.
    """
    async def boom(payload):  # pragma: no cover - should not fire
        raise AssertionError(
            "raw_text gating failed — augmentor queried %r" % payload
        )
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", boom)

    poisoned_chunk_text = "is causes youtube to terminate accounts going to rain today"
    raw_text = "is it going to rain today?"
    chunks = [_chunk(0, poisoned_chunk_text)]
    routes = [_route(0, "direct_chat")]
    executions = [_exec(0, "direct_chat")]

    cards = await augment_with_media(chunks, routes, executions, raw_text=raw_text)
    assert cards == []


@pytest.mark.anyio
async def test_dedupes_by_url_and_caps_at_three(monkeypatch):
    """Five eligible chunks → cap at 3 cards, drop duplicate URLs."""
    async def fake_get_video(payload):
        # Chunks 0/1 share one URL; chunks 2/3/4 each unique.
        query = payload["params"]["query"]
        url_map = {
            "tell me about alpha": "https://www.youtube.com/watch?v=dup11111111",
            "tell me about bravo": "https://www.youtube.com/watch?v=dup11111111",
            "tell me about charlie": "https://www.youtube.com/watch?v=uniq22222222",
            "tell me about delta": "https://www.youtube.com/watch?v=uniq33333333",
            "tell me about echo": "https://www.youtube.com/watch?v=uniq44444444",
        }
        url = url_map[query]
        return {
            "success": True,
            "sources": [{
                "url": url,
                "title": f"video {query}",
                "video_id": url.split("=")[-1],
            }],
        }
    monkeypatch.setattr("lokidoki.orchestrator.skills.youtube.get_video", fake_get_video)

    texts = [f"tell me about {w}" for w in ("alpha", "bravo", "charlie", "delta", "echo")]
    chunks = [_chunk(i, t) for i, t in enumerate(texts)]
    routes = [_route(i, "lookup_movie") for i in range(5)]
    executions = [_exec(i, "lookup_movie") for i in range(5)]

    cards = await augment_with_media(chunks, routes, executions)

    assert len(cards) == 3
    urls = [c["url"] for c in cards]
    assert len(set(urls)) == 3  # no duplicates survived
