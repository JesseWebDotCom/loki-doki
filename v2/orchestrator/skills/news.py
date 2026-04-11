"""v2 news headlines adapter — wraps lokidoki.skills.news_rss.

The v1 NewsRSSSkill exposes a single ``google_news_rss`` mechanism
that supports a fixed list of canned topic feeds (world, us, business,
tech, sports, science, health, entertainment) and falls back to a
search query for anything else.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.skills.news_rss.skill import NewsRSSSkill, TOPIC_FEEDS

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = NewsRSSSkill()

_TRIM_PREFIXES = (
    "what's the news on ",
    "whats the news on ",
    "news about ",
    "news on ",
    "what's happening with ",
    "tell me the news",
    "give me the news",
    "show me the news",
    "what's in the news",
    "headlines",
)


def _extract_topic(payload: dict[str, Any]) -> str | None:
    explicit = (payload.get("params") or {}).get("topic")
    if explicit:
        return str(explicit)
    text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    if not text:
        return None
    for prefix in _TRIM_PREFIXES:
        if text.startswith(prefix):
            tail = text[len(prefix):].strip()
            return tail or None
    # Detect a known topic word inside the chunk.
    tokens = re.findall(r"[a-zA-Z]+", text)
    for tok in tokens:
        if tok in TOPIC_FEEDS:
            return tok
    return None


def _format_success(result, method: str) -> str:
    data = result.data or {}
    topic = data.get("topic") or "top"
    headlines = data.get("headlines") or []
    if not headlines:
        return f"I couldn't find any current {topic} headlines."
    first = headlines[0]
    title = first.get("title") or "(untitled)"
    source = first.get("source") or ""
    suffix = f" ({source})" if source else ""
    extra_count = len(headlines) - 1
    extra = f" Plus {extra_count} more." if extra_count > 0 else ""
    return f"Top {topic} headline: {title}{suffix}.{extra}"


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    topic = _extract_topic(payload)
    attempts = [("google_news_rss", {"topic": topic, "limit": 5})]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed="I couldn't reach Google News right now.",
    )
    return result.to_payload()
