"""YouTube skill adapters for the orchestrator."""
from __future__ import annotations

from typing import Any

from lokidoki.skills.youtube.skill import YouTubeSkill
from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = YouTubeSkill()

# Keys from MechanismResult.data that the frontend cards consume.
_CARD_KEYS = (
    "type",
    "video_id",
    "channel",
    "channel_name",
    "channel_url",
    "handle",
    "featured_video_id",
    "video_type",
    "score",
)


def _enrich_sources(result: AdapterResult) -> AdapterResult:
    """Merge skill ``data`` fields onto the first source so frontend cards
    can read ``video_id`` / ``channel_name`` / ``handle`` / ``featured_video_id``
    without those fields getting stripped by the generic sources collector.
    """
    if not result.success or not result.data or not result.sources:
        return result
    extras = {k: result.data[k] for k in _CARD_KEYS if k in result.data and result.data[k] is not None}
    if not extras:
        return result
    result.sources[0] = {**result.sources[0], **extras}
    return result


async def get_video(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").strip()
    result = await run_mechanisms(
        _SKILL,
        [("get_video", {"query": query})],
        on_success=lambda res, method: "",
        on_all_failed="I couldn't find any videos for that.",
    )
    return _enrich_sources(result).to_payload()


async def get_music_video(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    query = str(params.get("query") or payload.get("chunk_text") or "").strip()
    video_type = str(params.get("video_type") or "official").strip()

    result = await run_mechanisms(
        _SKILL,
        [("get_music_video", {"query": query, "video_type": video_type})],
        on_success=lambda res, method: "",
        on_all_failed="I couldn't find that music video.",
    )
    return _enrich_sources(result).to_payload()


async def get_youtube_channel(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("query") or payload.get("chunk_text") or "").strip()
    result = await run_mechanisms(
        _SKILL,
        [("get_youtube_channel", {"query": query})],
        on_success=lambda res, method: "",
        on_all_failed="I couldn't find that YouTube channel.",
    )
    return _enrich_sources(result).to_payload()
