import re
import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

DDG_API_URL = "https://api.duckduckgo.com/"
DDG_HTML_URL = "https://html.duckduckgo.com/html/"

# DDG's Instant Answer API sometimes returns self-referential rows
# ("About DuckDuckGo", "DuckDuckGo is a search engine...") when the
# query has no good AbstractText. Those leak the brand name into the
# final LLM response ("...don't ignore it! DuckDuckGo If..."). This
# regex strips the brand from snippets before they reach the prompt.
_BRAND_LEAK_RE = re.compile(
    r"\b(?:about\s+)?duckduckgo(?:\s+is\s+a[^.]*\.?)?\b",
    re.IGNORECASE,
)


def _strip_brand(text: str) -> str:
    cleaned = _BRAND_LEAK_RE.sub("", text or "")
    # Collapse whitespace left behind by the excision.
    return re.sub(r"\s{2,}", " ", cleaned).strip(" .,;:")


class DuckDuckGoSkill(BaseSkill):
    """Web search via DuckDuckGo instant answers API with HTML scraper fallback."""

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "ddg_api":
            return await self._ddg_api(parameters)
        elif method == "ddg_scraper":
            return await self._ddg_scraper(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _ddg_api(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    DDG_API_URL,
                    params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"DDG API error: {response.status_code}")

            data = response.json()
            abstract = _strip_brand(data.get("AbstractText", ""))
            heading = _strip_brand(data.get("Heading", ""))
            source_url = data.get("AbstractURL", "")

            # Also collect related topics as results. Skip any topic
            # that reduces to empty after brand-stripping — those are
            # DDG self-referential rows with no real content.
            results: list[str] = []
            for topic in data.get("RelatedTopics", [])[:5]:
                text = _strip_brand(topic.get("Text", "")) if isinstance(topic, dict) else ""
                if text:
                    results.append(text)

            if not abstract and not results:
                return MechanismResult(success=False, error="No instant answer available")

            return MechanismResult(
                success=True,
                data={
                    "heading": heading,
                    "abstract": abstract,
                    "results": results,
                },
                source_url=source_url or f"https://duckduckgo.com/?q={query}",
                # Plain title — no brand prefix. The LLM prompt renders
                # ``[src:N] {title} ({url})`` for citations; the brand
                # name only creeps back if we put it there ourselves.
                source_title=heading or query,
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    async def _ddg_scraper(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                response = await client.post(
                    DDG_HTML_URL,
                    data={"q": query},
                    headers={"User-Agent": "LokiDoki/1.0"},
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"DDG scraper error: {response.status_code}")

            # Extract result snippets from HTML
            snippets = re.findall(
                r'class="result__snippet"[^>]*>(.*?)</a>',
                response.text,
                re.DOTALL,
            )
            clean = [_strip_brand(re.sub(r'<[^>]+>', '', s)) for s in snippets[:5]]
            clean = [s for s in clean if s]

            if not clean:
                return MechanismResult(success=False, error="No results scraped")

            return MechanismResult(
                success=True,
                data={"results": clean},
                source_url=f"https://duckduckgo.com/?q={query}",
                source_title=query,
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))
