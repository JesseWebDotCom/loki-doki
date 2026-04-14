"""Media augmentor — fans out media-producer skills in parallel and
returns up to N compact media cards to render above the assistant text.

Public surface:
    augment_with_media(chunks, routes, executions) -> list[MediaCard]

A MediaCard is a plain dict with a required ``kind`` discriminator
(``youtube_video`` | ``youtube_channel``) and kind-specific fields the
frontend consumes. Keeping it a dict (not a dataclass) means the card
serializes to JSON for the SSE event with no extra work.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    RequestChunk,
    RouteMatch,
)

logger = logging.getLogger("lokidoki.orchestrator.media")


# Queries whose subject is a bare pronoun ("is it free", "what is she
# like") are almost always clarification-triggering. If the antecedent
# resolver had succeeded, those pronouns would already be rewritten to
# the real subject — so seeing them here means the chunk is vague and
# augmentation would produce a random, misleading video.
_PRONOUN_LEAD_RE = re.compile(
    r"^\s*(?:is|are|was|were|do|does|did|can|could|will|would|has|have|had|"
    r"what\s+is|what\s+are|what\s+does|who\s+is|who\s+are)?\s*"
    r"(it|this|that|they|them|he|she|him|her|those|these)\b",
    re.IGNORECASE,
)


def _has_concrete_subject(text: str) -> bool:
    """Reject chunks too vague to warrant a media card.

    A chunk qualifies as concrete when:
    1. It is at least 10 characters long (excludes "is it free", "yo"), AND
    2. It contains at least two tokens of length >= 4 (excludes "am I evil",
       "is it free", "tell me more"), AND
    3. It does not lead with an unresolved subject pronoun pattern.
    """
    stripped = (text or "").strip()
    if len(stripped) < 10:
        return False
    if _PRONOUN_LEAD_RE.match(stripped):
        return False
    long_tokens = sum(1 for tok in re.findall(r"[A-Za-z0-9]+", stripped) if len(tok) >= 4)
    return long_tokens >= 2


# Capabilities whose primary result already carries YouTube data we can
# surface directly — no extra fan-out needed.
YOUTUBE_NATIVE_CAPABILITIES = frozenset({
    "get_youtube_channel",
    "get_video",
    "get_music_video",
})

# Non-YouTube primary capabilities that benefit from a YouTube
# augmentation card. Deliberately narrow: media only appears when the
# router classified the user's intent as "I want this piece of media",
# not when the user asked a question that happens to mention a
# media-able subject. Mirrors how ChatGPT decides — a trailer is the
# natural answer object for "best Kubrick movie", but NOT for "what
# causes X" or "is it raining". General-knowledge capabilities
# (direct_chat / knowledge_query / search_web / lookup_fact /
# lookup_definition) are intentionally excluded: attaching a random
# video to a factual text answer is noise, every time.
MEDIA_ELIGIBLE_CAPABILITIES = frozenset({
    # Movies — trailers / clips are the canonical visual payload.
    "lookup_movie",
    "search_movies",
    # TV — previews / episode clips.
    "lookup_tv_show",
    "get_episode_detail",
    # Music — user asking for a song implicitly wants the music video.
    "play_music",
    "lookup_track",
})

# Capabilities for which the YouTube augment should search music video
# pages rather than general videos. When the primary intent is music,
# a music-video result is a much better card than a plain video search.
_MUSIC_AUGMENT_CAPABILITIES = frozenset({
    "play_music",
    "lookup_track",
    "get_now_playing",
})

_MAX_CARDS = 3


def _card_from_youtube_native(execution: ExecutionResult) -> dict[str, Any] | None:
    """Extract a MediaCard from a YouTube-native primary execution's raw_result.

    The YouTube adapters already enrich ``sources[0]`` with the card
    fields (see ``orchestrator/skills/youtube.py``), so we just read
    the enriched source rather than re-querying.
    """
    raw = execution.raw_result or {}
    if not raw.get("success", True):
        return None
    sources = raw.get("sources") or []
    if not sources:
        return None
    src = sources[0]
    src_type = src.get("type")
    if src_type == "channel" or "channel_url" in src or "handle" in src:
        return _build_channel_card(src)
    if src_type == "video" or "video_id" in src:
        return _build_video_card(src)
    return None


def _build_channel_card(src: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "youtube_channel",
        "url": src.get("channel_url") or src.get("url") or "",
        "channel_name": src.get("channel_name") or src.get("title") or "",
        "handle": src.get("handle"),
        "featured_video_id": src.get("featured_video_id"),
        "avatar_url": src.get("avatar_url"),
    }


def _build_video_card(src: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "youtube_video",
        "url": src.get("url") or "",
        "video_id": src.get("video_id"),
        "title": src.get("title") or "",
        "channel": src.get("channel") or src.get("channel_name"),
        "video_type": src.get("video_type"),
        "score": src.get("score"),
    }


async def _augment_one_text(query: str, route: RouteMatch) -> dict[str, Any] | None:
    """Run the YouTube producer for one query + return a MediaCard or None.

    Uses ``get_music_video`` for music-routed chunks, ``get_video`` for
    everything else. Failures are logged and swallowed — augmentation
    is best-effort.
    """
    query = (query or "").strip()
    if not query:
        return None
    try:
        if route.capability in _MUSIC_AUGMENT_CAPABILITIES:
            from lokidoki.orchestrator.skills.youtube import get_music_video
            payload = {"params": {"query": query, "video_type": "official"}, "chunk_text": query}
            result = await get_music_video(payload)
        else:
            from lokidoki.orchestrator.skills.youtube import get_video
            payload = {"params": {"query": query}, "chunk_text": query}
            result = await get_video(payload)
    except Exception:  # noqa: BLE001 - augmentation must never break pipeline
        logger.exception("media augmentation failed for query %r", query)
        return None
    if not result.get("success"):
        return None
    sources = result.get("sources") or []
    if not sources:
        return None
    return _build_video_card(sources[0])


async def augment_with_media(
    chunks: list[RequestChunk],
    routes: list[RouteMatch],
    executions: list[ExecutionResult],
    raw_text: str = "",
) -> list[dict[str, Any]]:
    """Return up to :data:`_MAX_CARDS` media cards for the current turn.

    1. For YouTube-native primary chunks, surface their existing card.
    2. For non-YouTube eligible primary chunks, fan out one YouTube
       producer coroutine per chunk, gather in parallel.
    3. Cap total output at three cards, deduped by URL.

    ``raw_text`` is the user's original utterance. For single-chunk
    turns it overrides the post-antecedent-resolution ``chunk.text``
    for both the vague-query gate and the producer query — otherwise a
    stale ``recent_entity`` from a prior turn can inject an unrelated
    topic into the media search (e.g. a weather question turns into a
    search for whatever the previous question was about).
    """
    route_by_idx = {r.chunk_index: r for r in routes}
    exec_by_idx = {e.chunk_index: e for e in executions}

    primary_chunks = [c for c in chunks if c.role == "primary_request"]

    native_cards: list[dict[str, Any]] = []
    augment_tasks: list[tuple[str, RouteMatch]] = []

    for chunk in primary_chunks:
        route = route_by_idx.get(chunk.index)
        execution = exec_by_idx.get(chunk.index)
        if route is None or execution is None:
            continue
        if route.capability in YOUTUBE_NATIVE_CAPABILITIES:
            card = _card_from_youtube_native(execution)
            if card:
                native_cards.append(card)
            continue
        if route.capability not in MEDIA_ELIGIBLE_CAPABILITIES or not execution.success:
            continue
        # Single-chunk turns: the raw user text is the truthful signal,
        # not the antecedent-resolved chunk text (which can be
        # contaminated by a stale entity from a prior turn).
        source_text = raw_text if (raw_text and len(primary_chunks) == 1) else chunk.text
        if not _has_concrete_subject(source_text):
            continue
        augment_tasks.append((source_text, route))

    if not augment_tasks:
        return _dedupe_cap(native_cards)

    results = await asyncio.gather(
        *(_augment_one_text(query, route) for query, route in augment_tasks),
        return_exceptions=False,
    )
    augmented = [card for card in results if card]

    # Native cards first — they are the user's primary intent.
    return _dedupe_cap(native_cards + augmented)


def _dedupe_cap(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for card in cards:
        key = card.get("url") or card.get("video_id") or ""
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        out.append(card)
        if len(out) >= _MAX_CARDS:
            break
    return out
