"""News headlines via Google News RSS — free, no key, language-tunable."""
from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

# Google News RSS endpoints. Topic feeds for canned categories, search for the rest.
TOPIC_FEEDS = {
    "world": "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
    "us": "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en",
    "business": "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
    "tech": "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
    "technology": "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
    "sports": "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en",
    "science": "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en",
    "health": "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en",
    "entertainment": "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en",
}
TOP = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
SEARCH = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"


def _resolve_url(topic: str | None) -> str:
    if not topic:
        return TOP
    key = topic.strip().lower()
    if key in TOPIC_FEEDS:
        return TOPIC_FEEDS[key]
    return SEARCH.format(q=httpx.QueryParams({"q": topic}).get("q"))


class NewsRSSSkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "google_news_rss":
            raise ValueError(f"Unknown mechanism: {method}")
        topic = parameters.get("topic") or parameters.get("query")
        try:
            limit = int(parameters.get("limit") or 5)
        except (TypeError, ValueError):
            limit = 5
        limit = max(1, min(limit, 15))
        url = _resolve_url(topic)
        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                resp = await client.get(url, headers={"User-Agent": "LokiDoki/0.2"})
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if resp.status_code != 200:
            return MechanismResult(success=False, error=f"http {resp.status_code}")
        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError as exc:
            return MechanismResult(success=False, error=f"malformed feed: {exc}")
        items = []
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            source_el = item.find("{http://search.yahoo.com/mrss/}source") or item.find("source")
            source = (source_el.text or "").strip() if source_el is not None and source_el.text else ""
            if title:
                items.append({"title": title, "link": link, "published": pub, "source": source})
            if len(items) >= limit:
                break
        if not items:
            return MechanismResult(success=False, error="no headlines found")
        return MechanismResult(
            success=True,
            data={"topic": topic or "top", "headlines": items},
            source_url=url,
            source_title=f"Google News — {topic or 'top stories'}",
        )
