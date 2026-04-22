import re
import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

DDG_API_URL = "https://api.duckduckgo.com/"
DDG_HTML_URL = "https://html.duckduckgo.com/html/"
DDG_HOME_URL = "https://duckduckgo.com/"
DDG_IMAGES_URL = "https://duckduckgo.com/i.js"

# DDG's image API is a two-step flow: hit the homepage with the query
# to obtain a short-lived ``vqd`` token, then hit ``i.js`` with that
# token. The token is embedded in the HTML as ``vqd=...`` — accept
# single/double/no quotes since the format has changed before.
_VQD_RE = re.compile(r'vqd=(["\']?)([\d-]+)\1')

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
    """Web search via DuckDuckGo instant answers API with HTML scraper fallback.

    Implements the shared "web-search skill" contract. Any provider in
    this slot (DuckDuckGo today, Brave/Kagi/Searx tomorrow) MUST expose:

    * ``ddg_api`` / ``ddg_scraper`` — text results (``web_search_source``
      in the shared ``_runner`` wraps these).
    * ``image_search`` — returns up to N image result dicts
      (``{title, image_url, thumbnail, source_url, width, height}``).
      Called by :func:`lokidoki.orchestrator.skills._runner.web_image_search_source`
      and threaded into ``AdapterOutput.media`` as ``kind="image"`` cards.
    """

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "ddg_api":
            return await self._ddg_api(parameters)
        elif method == "ddg_scraper":
            return await self._ddg_scraper(parameters)
        elif method == "image_search":
            return await self._image_search(parameters)
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

    async def _image_search(self, parameters: dict) -> MechanismResult:
        """Return up to ``limit`` image results for the given query.

        DuckDuckGo's image endpoint requires a short-lived ``vqd`` token
        obtained by loading the homepage once. Both requests are wrapped
        in a tight timeout so an offline or network-degraded turn fails
        fast and silently; the caller degrades to "no extra images"
        instead of blocking.
        """
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")
        limit = int(parameters.get("limit") or 3)
        try:
            async with httpx.AsyncClient(
                timeout=3.0,
                follow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 LokiDoki"},
            ) as client:
                home = await client.get(
                    DDG_HOME_URL,
                    params={"q": query, "iax": "images", "ia": "images"},
                )
                if home.status_code != 200:
                    return MechanismResult(success=False, error=f"DDG home error: {home.status_code}")
                match = _VQD_RE.search(home.text)
                if not match:
                    return MechanismResult(success=False, error="no vqd token")
                vqd = match.group(2)
                resp = await client.get(
                    DDG_IMAGES_URL,
                    params={
                        "l": "us-en",
                        "o": "json",
                        "q": query,
                        "vqd": vqd,
                        "f": ",,,,,",
                        "p": "1",
                    },
                    headers={
                        "Accept": "application/json",
                        "Referer": "https://duckduckgo.com/",
                    },
                )
            if resp.status_code != 200:
                return MechanismResult(success=False, error=f"DDG images error: {resp.status_code}")
            payload = resp.json()
            items: list[dict] = []
            for row in payload.get("results", [])[: limit * 2]:
                image_url = str(row.get("image") or "").strip()
                if not image_url or not image_url.startswith(("http://", "https://")):
                    continue
                items.append({
                    "title": str(row.get("title") or "").strip(),
                    "image_url": image_url,
                    "thumbnail": str(row.get("thumbnail") or "").strip(),
                    "source_url": str(row.get("url") or "").strip(),
                    "width": int(row.get("width") or 0),
                    "height": int(row.get("height") or 0),
                })
                if len(items) >= limit:
                    break
            if not items:
                return MechanismResult(success=False, error="no image results")
            return MechanismResult(
                success=True,
                data={"images": items},
                source_url=f"https://duckduckgo.com/?q={query}&iax=images&ia=images",
                source_title=f"DuckDuckGo images — {query}",
            )
        except Exception as e:  # noqa: BLE001
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
