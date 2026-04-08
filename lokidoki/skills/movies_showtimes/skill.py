"""Current movie showtimes via live web search.

This provider does not try to infer intent from the user's text. It
simply takes the decomposer-distilled query, adds the provider-specific
"showtimes" term, optionally appends the configured default location,
and extracts the top live search result snippets into a normalized
payload for synthesis.
"""
from __future__ import annotations

import re
from urllib.parse import quote_plus

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

DDG_HTML_URL = "https://html.duckduckgo.com/html/"
TIME_PATTERN = re.compile(r"\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b", re.IGNORECASE)


def _search_query(raw_query: str, default_location: str = "") -> str:
    parts = [raw_query.strip(), "showtimes"]
    location = (default_location or "").strip()
    if location:
        parts.append(location)
    return " ".join(p for p in parts if p).strip()


def _normalize_url(raw_url: str) -> str:
    url = (raw_url or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _extract_results(html: str) -> list[dict]:
    titles = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    )
    snippets = re.findall(
        r'class="result__snippet"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    )
    out: list[dict] = []
    for idx, (url, title_html) in enumerate(titles[:5]):
        title = re.sub(r"<[^>]+>", "", title_html).strip()
        snippet = ""
        if idx < len(snippets):
            snippet = re.sub(r"<[^>]+>", "", snippets[idx]).strip()
        if not title:
            continue
        if not TIME_PATTERN.search(snippet):
            continue
        out.append({
            "title": title,
            "snippet": snippet,
            "url": _normalize_url(url),
        })
    return out


def _build_lead(query: str, results: list[dict]) -> str:
    if not results:
        return ""
    first = results[0]
    snippet = (first.get("snippet") or "").strip()
    title = (first.get("title") or "").strip()
    if snippet:
        return f"{title}: {snippet}"
    return f"I found current showtimes for {query}. Top listing: {title}."


class MovieShowtimesSkill(BaseSkill):
    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "ddg_showtimes":
            return await self._ddg_showtimes(parameters)
        if method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _ddg_showtimes(self, parameters: dict) -> MechanismResult:
        raw_query = (parameters.get("query") or "").strip()
        if not raw_query:
            return MechanismResult(success=False, error="Query parameter required")

        cfg = parameters.get("_config") or {}
        search_query = _search_query(raw_query, cfg.get("default_location", ""))

        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                response = await client.post(
                    DDG_HTML_URL,
                    data={"q": search_query},
                    headers={"User-Agent": "LokiDoki/1.0"},
                )

            if response.status_code != 200:
                return MechanismResult(
                    success=False, error=f"Showtimes search error: {response.status_code}"
                )

            results = _extract_results(response.text)
            if not results:
                return MechanismResult(success=False, error="No showtimes found")

            data = {
                "query": raw_query,
                "search_query": search_query,
                "showtimes": results,
                "lead": _build_lead(raw_query, results),
            }
            self._cache[raw_query.lower()] = data
            return MechanismResult(
                success=True,
                data=data,
                source_url=f"https://duckduckgo.com/?q={quote_plus(search_query)}",
                source_title=f"DuckDuckGo showtimes - {raw_query}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        query = (parameters.get("query") or "").lower()
        cached = self._cache.get(query)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")
