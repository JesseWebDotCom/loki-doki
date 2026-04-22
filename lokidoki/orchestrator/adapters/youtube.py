"""Response adapter for the YouTube skill.

For YouTube the media IS the payload — the user asked for a video or a
channel, so the structured answer lives in ``media`` (not ``summary``).
The discriminator shape matches the canonical ``MediaCard`` type in
``frontend/src/lib/api-types.ts`` (``kind: "youtube_video" |
"youtube_channel"``). The shape is deliberately passed through verbatim
so the existing UI renderers keep working unchanged.
"""
from __future__ import annotations

from typing import Any

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class YouTubeAdapter:
    skill_id = "youtube"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        card = _build_media_card(data)
        if card is None:
            return AdapterOutput(raw=data)

        url = str(card.get("url") or "").strip()
        if card["kind"] == "youtube_video":
            title = str(card.get("title") or "").strip() or "YouTube video"
            source_title = title
        else:
            title = str(card.get("channel_name") or "").strip() or "YouTube channel"
            source_title = title

        sources: tuple[Source, ...] = ()
        if url or title:
            sources = (
                Source(
                    title=source_title,
                    url=url or None,
                    kind="web",
                ),
            )

        follow_ups: tuple[str, ...] = ()
        if data.get("related") or data.get("related_videos"):
            follow_ups = ("Show more like this",)

        return AdapterOutput(
            media=(card,),
            sources=sources,
            follow_up_candidates=follow_ups,
            raw=data,
        )


def _build_media_card(data: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize skill data into a MediaCard-shaped dict.

    The skill returns one of three payload flavors: a video (``type``
    absent or ``"video"`` with ``video_id``), a channel (``type ==
    "channel"`` or ``channel_url``/``handle`` present), or nothing
    useful. Anything else is a safe ``None``.
    """
    if not isinstance(data, dict) or not data:
        return None
    data_type = str(data.get("type") or "").strip().lower()

    if data_type == "channel" or "channel_url" in data or (
        "handle" in data and "video_id" not in data
    ):
        url = str(data.get("channel_url") or data.get("url") or "").strip()
        if not url and not data.get("handle"):
            return None
        card: dict[str, Any] = {"kind": "youtube_channel", "url": url}
        channel_name = data.get("channel_name") or data.get("title")
        if channel_name:
            card["channel_name"] = str(channel_name)
        handle = data.get("handle")
        if handle:
            card["handle"] = str(handle)
        featured = data.get("featured_video_id")
        if featured:
            card["featured_video_id"] = str(featured)
        avatar = data.get("avatar_url")
        if avatar:
            card["avatar_url"] = str(avatar)
        return card

    if data.get("video_id") or data_type == "video":
        url = str(data.get("url") or "").strip()
        card = {"kind": "youtube_video", "url": url}
        video_id = data.get("video_id")
        if video_id:
            card["video_id"] = str(video_id)
        title = data.get("title")
        if title:
            card["title"] = str(title)
        channel = data.get("channel") or data.get("channel_name")
        if channel:
            card["channel"] = str(channel)
        video_type = data.get("video_type")
        if video_type:
            card["video_type"] = str(video_type)
        score = data.get("score")
        if score is not None:
            card["score"] = score
        if not url and not video_id:
            return None
        return card

    return None
