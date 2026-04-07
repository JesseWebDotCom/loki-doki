import re
import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

WIKI_API_URL = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "LokiDoki/0.1 (https://github.com/lokidoki; local assistant) httpx"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


class WikipediaSkill(BaseSkill):
    """Fetches knowledge from Wikipedia via MediaWiki API or web scraping."""

    def __init__(self):
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "mediawiki_api":
            return await self._mediawiki_api(parameters)
        elif method == "web_scraper":
            return await self._web_scraper(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _mediawiki_api(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS) as client:
                response = await client.get(
                    WIKI_API_URL,
                    params={
                        "action": "query",
                        "titles": query,
                        "prop": "extracts",
                        "exintro": True,
                        "explaintext": True,
                        "format": "json",
                    },
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"Wikipedia API error: {response.status_code}")

            pages = response.json().get("query", {}).get("pages", {})
            for page_id, page in pages.items():
                if page_id == "-1" or "missing" in page:
                    return MechanismResult(success=False, error="No Wikipedia article found")

                title = page.get("title", query)
                extract = page.get("extract", "")
                data = {"title": title, "extract": extract}

                self._cache[query.lower()] = data

                return MechanismResult(
                    success=True,
                    data=data,
                    source_url=f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
                    source_title=f"Wikipedia - {title}",
                )

            return MechanismResult(success=False, error="No pages in response")
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    async def _web_scraper(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS) as client:
                # First search for the article
                search_resp = await client.get(
                    WIKI_API_URL,
                    params={
                        "action": "query",
                        "list": "search",
                        "srsearch": query,
                        "format": "json",
                        "srlimit": 1,
                    },
                )

            if search_resp.status_code != 200:
                return MechanismResult(success=False, error=f"Wikipedia search error: {search_resp.status_code}")

            results = search_resp.json().get("query", {}).get("search", [])
            if not results:
                return MechanismResult(success=False, error="No search results found")

            title = results[0]["title"]
            page_url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"

            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS, follow_redirects=True) as client:
                page_resp = await client.get(page_url)

            # Simple HTML text extraction (strip tags)
            text = re.sub(r'<[^>]+>', '', page_resp.text)
            # Extract first ~500 chars of meaningful content
            content = text[:2000].strip()

            return MechanismResult(
                success=True,
                data={"title": title, "content": content},
                source_url=page_url,
                source_title=f"Wikipedia - {title}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))
