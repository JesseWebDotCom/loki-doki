import re
import httpx
import asyncio
from typing import Optional, Literal
from urllib.parse import quote

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

DDG_URL = "https://html.duckduckgo.com/html/"
OEMBED_URL = "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"

class YouTubeSkill(BaseSkill):
    """YouTube search skill with specialized music and creator discovery."""

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "get_video":
            return await self._get_video(parameters)
        elif method == "get_music_video":
            return await self._get_music_video(parameters)
        elif method == "get_youtube_channel":
            return await self._get_youtube_channel(parameters)
        raise ValueError(f"Unknown method: {method}")

    async def _get_video(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query required")

        # Direct YouTube search
        results = await self._search_youtube(query)
        if not results:
            return MechanismResult(success=False, error="No videos found")

        video_results = [r for r in results if r["type"] == "video"]
        if not video_results:
            return MechanismResult(success=False, error="No videos found in results")

        # Walk the candidate list in search order, probing each via
        # oEmbed. YouTube's oEmbed endpoint returns an empty payload
        # for videos that are private, age-gated, region-blocked, or
        # have embedding disabled by the uploader — exactly the videos
        # that would render "Video unavailable" in the iframe. Pick
        # the first candidate whose metadata actually comes back.
        for candidate in video_results[:6]:
            meta = await self._get_video_metadata(candidate["id"])
            if not meta:
                continue
            return MechanismResult(
                success=True,
                data={
                    "type": "video",
                    "video_id": candidate["id"],
                    "title": meta.get("title") or candidate["title"],
                    "channel": meta.get("author_name", ""),
                    "url": f"https://www.youtube.com/watch?v={candidate['id']}",
                },
                source_url=f"https://www.youtube.com/watch?v={candidate['id']}",
                source_title=f"YouTube - {meta.get('title') or candidate['title']}",
            )
        return MechanismResult(success=False, error="No embeddable videos found")

    async def _get_music_video(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        video_type = parameters.get("video_type", "official")
        
        # Build specific keywords for YouTube
        search_query = query
        if video_type == "live":
            search_query += " live performance"
        elif video_type == "cover":
            search_query += " cover"
        else:
            search_query += " official music video"

        results = await self._search_youtube(search_query)
        video_results = [r for r in results if r["type"] == "video"]
        if not video_results:
            return MechanismResult(success=False, error="No music videos found")

        # Score only candidates that are actually embeddable — oEmbed
        # returns empty for blocked / private / embed-disabled videos.
        # Probe the top 8 to leave room after filtering.
        scored_results = []
        for res in video_results[:8]:
            meta = await self._get_video_metadata(res["id"])
            if not meta:
                continue
            score = self._calculate_relevance(query, video_type, res, meta)
            scored_results.append({
                "id": res["id"],
                "score": score,
                "meta": meta,
            })

        if not scored_results:
            return MechanismResult(success=False, error="No embeddable music videos found")

        scored_results.sort(key=lambda x: x["score"], reverse=True)
        best = scored_results[0]

        if best["score"] < 0.35:
            return MechanismResult(success=False, error="No highly relevant music video found")

        return MechanismResult(
            success=True,
            data={
                "video_id": best["id"],
                "title": best["meta"].get("title"),
                "channel": best["meta"].get("author_name"),
                "video_type": video_type,
                "score": round(best["score"], 2),
                "url": f"https://www.youtube.com/watch?v={best['id']}"
            },
            source_url=f"https://www.youtube.com/watch?v={best['id']}",
            source_title=f"YouTube - {best['meta'].get('title')}"
        )

    async def _get_youtube_channel(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query", "").strip()
        if not query:
            return MechanismResult(success=False, error="Channel name or handle required")

        results = await self._search_youtube(query)
        
        # Look for channel records
        channel_results = [r for r in results if r["type"] == "channel"]
        
        if not channel_results:
            # If no direct channel object, look for a video from the requested channel
            video_results = [r for r in results if r["type"] == "video"]
            if video_results:
                # Try to derive channel from the first video
                meta = await self._get_video_metadata(video_results[0]["id"])
                handle = meta.get("author_url", "").split("/")[-1]
                if handle:
                    channel_results = [{"handle": handle, "name": meta.get("author_name")}]

        if not channel_results:
            return MechanismResult(success=False, error="Could not find that YouTube channel")

        best_channel = channel_results[0]
        channel_name = best_channel.get("name")
        handle = best_channel["handle"]
        channel_url = f"https://www.youtube.com/{handle}"

        # Walk the candidate videos and pick the first embeddable one
        # so the channel card never renders an "unavailable" iframe.
        video_search = f"{handle} latest video"
        v_results = await self._search_youtube(video_search)
        candidate_ids = [r["id"] for r in v_results if r["type"] == "video"]

        featured_video_id: str | None = None
        featured_meta: dict = {}
        for vid in candidate_ids[:6]:
            meta = await self._get_video_metadata(vid)
            if meta:
                featured_video_id = vid
                featured_meta = meta
                break

        if featured_meta:
            if not channel_name or channel_name in ["YouTube Channel", "None", "null"]:
                channel_name = featured_meta.get("author_name")
            if not handle or handle in ["null", "None"]:
                handle = featured_meta.get("author_url", "").split("/")[-1]

        # Final fallback for channel name
        if not channel_name or channel_name in ["None", "null"]:
            channel_name = query.title()

        return MechanismResult(
            success=True,
            data={
                "type": "channel",
                "channel_name": channel_name,
                "channel_url": channel_url,
                "handle": handle,
                "featured_video_id": featured_video_id,
            },
            source_url=channel_url,
            source_title=f"YouTube Channel - {channel_name}",
        )

    async def _search_youtube(self, query: str) -> list[dict]:
        """Performs a direct YouTube search and extracts video IDs and channel handles."""
        search_url = f"https://www.youtube.com/results?search_query={quote(query)}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
        
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                response = await client.get(search_url, headers=headers)
                if response.status_code != 200:
                    return []
                
                html = response.text
                results = []
                
                # 1. Extract Video IDs from JSON/HTML
                # Pattern: "videoId":"XXXXXXXXXXX"
                vids = re.findall(r'"videoId":"([a-zA-Z0-9_-]{11})"', html)
                seen_vids = set()
                for vid in vids:
                    if vid not in seen_vids:
                        results.append({"type": "video", "id": vid, "title": "YouTube Video"})
                        seen_vids.add(vid)
                
                # 2. Extract Channel Handles and Names from JSON/HTML
                # This matches the "longBylineText" structure common in search results
                # It captures both the name and the handle/URL path
                channel_blocks = re.findall(r'"longBylineText":\{"runs":\[\{"text":"([^"]+)","navigationEndpoint":\{"browseEndpoint":\{"browseId":"[^"]+","canonicalBaseUrl":"/(@[a-zA-Z0-9_-]+|channel/[a-zA-Z0-9_-]+|user/[a-zA-Z0-9_-]+)"', html)
                seen_channels = set()
                for name, path in channel_blocks:
                    if path not in seen_channels:
                        results.append({"type": "channel", "handle": path, "name": name, "id": None})
                        seen_channels.add(path)
                
                # Fallback simple handle extraction
                if not seen_channels:
                    handles = re.findall(r'"canonicalBaseUrl":"/(@[a-zA-Z0-9_-]+)"', html)
                    for handle in handles:
                        if handle not in seen_channels:
                            results.append({"type": "channel", "handle": handle, "name": None, "id": None})
                            seen_channels.add(handle)

                return results
        except Exception:
            return []

    async def _get_video_metadata(self, video_id: str) -> dict:
        """Fetches video metadata via oEmbed."""
        if not video_id:
            return {}
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                url = OEMBED_URL.format(video_id=video_id)
                response = await client.get(url)
                if response.status_code == 200:
                    return response.json()
        except:
            pass
        return {}

    def _calculate_relevance(self, query: str, video_type: str, search_res: dict, meta: dict) -> float:
        """Calculates a relevance score between 0.0 and 1.0."""
        score = 0.0
        title = (meta.get("title") or search_res.get("title") or "").lower()
        author = (meta.get("author_name") or "").lower()
        q = query.lower()

        # 1. Exact artist/song matches in title (weighted high)
        words = q.split()
        matches = sum(1 for w in words if w in title)
        score += (matches / len(words)) * 0.5 if words else 0

        # 2. Channel Authority
        # Official Artist Channels, Vevo, or Topics
        if author:
            if q in author or author in q:
                score += 0.3
            if "vevo" in author or " - topic" in author or "official" in author:
                score += 0.1

        # 3. Video Type Affinity
        if video_type == "official":
            if "official" in title and "video" in title:
                score += 0.2
            if "live" in title or "cover" in title or "karaoke" in title:
                score -= 0.4
        elif video_type == "live":
            if "live" in title or "concert" in title or "performance" in title:
                score += 0.2
        elif video_type == "cover":
            if "cover" in title or "tribute" in title:
                score += 0.2

        return max(0.0, min(1.0, score))
