"""Wikipedia knowledge skill.

Both mechanisms return a normalized payload:
    {"title": str, "lead": str, "sections": list[str], "url": str}

`lead` is the article's lead section (intro paragraphs before the first
section header). `sections` is a manifest of top-level section titles so
the orchestrator can offer follow-ups without re-fetching. We deliberately
do NOT truncate the lead to a fixed character budget — Wikipedia leads are
naturally bounded — but a hard safety cap protects against pathological
pages.
"""
from __future__ import annotations

from html.parser import HTMLParser
from html import unescape

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

WIKI_API_URL = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "LokiDoki/0.1 (https://github.com/lokidoki; local assistant) httpx"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}

# Absolute safety cap on lead length. Real Wikipedia leads are 500–3000
# chars; anything past 8k is almost certainly a parse failure.
LEAD_CHAR_CAP = 8000


def _page_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"


class _LeadExtractor(HTMLParser):
    """Pull the lead <p> paragraphs and top-level <h2> section titles.

    Wikipedia's article body lives in <div id="mw-content-text">. The lead
    is every <p> before the first <h2>. Section titles are the text inside
    <h2><span class="mw-headline">…</span></h2>.
    """

    def __init__(self) -> None:
        super().__init__()
        self._in_content = False
        self._content_depth = 0
        self._in_p = False
        self._in_h2 = False
        self._in_headline = False
        self._seen_first_h2 = False
        self._skip_depth = 0  # for refs/sup/style we want to drop
        self._lead_buf: list[str] = []
        self._cur_p: list[str] = []
        self._cur_section: list[str] = []
        self.lead_paragraphs: list[str] = []
        self.sections: list[str] = []

    def handle_starttag(self, tag: str, attrs):
        attrs_d = dict(attrs)
        if tag == "div" and attrs_d.get("id") == "mw-content-text":
            self._in_content = True
            self._content_depth = 1
            return
        if not self._in_content:
            return
        if tag == "div":
            self._content_depth += 1
        if tag in ("sup", "style", "script", "table"):
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "p" and not self._seen_first_h2:
            self._in_p = True
            self._cur_p = []
        elif tag == "h2":
            self._in_h2 = True
            self._cur_section = []
        elif self._in_h2 and tag == "span":
            cls = attrs_d.get("class", "")
            if "mw-headline" in cls:
                self._in_headline = True

    def handle_endtag(self, tag: str):
        if not self._in_content:
            return
        if tag in ("sup", "style", "script", "table"):
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "p" and self._in_p:
            text = "".join(self._cur_p).strip()
            if text:
                self.lead_paragraphs.append(text)
            self._in_p = False
        elif tag == "span" and self._in_headline:
            self._in_headline = False
        elif tag == "h2" and self._in_h2:
            title = "".join(self._cur_section).strip()
            if title and title.lower() not in ("contents",):
                self.sections.append(title)
            self._in_h2 = False
            self._seen_first_h2 = True
        elif tag == "div":
            self._content_depth -= 1
            if self._content_depth <= 0:
                self._in_content = False

    def handle_data(self, data: str):
        if not self._in_content or self._skip_depth:
            return
        if self._in_p:
            self._cur_p.append(data)
        elif self._in_headline:
            self._cur_section.append(data)


def _parse_wiki_html(html: str) -> tuple[str, list[str]]:
    parser = _LeadExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    lead = unescape("\n\n".join(parser.lead_paragraphs)).strip()
    if len(lead) > LEAD_CHAR_CAP:
        lead = lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "…"
    return lead, parser.sections


class WikipediaSkill(BaseSkill):
    """Fetches knowledge from Wikipedia via MediaWiki API or HTML scraping."""

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
                lead = (page.get("extract") or "").strip()
                if len(lead) > LEAD_CHAR_CAP:
                    lead = lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "…"
                url = _page_url(title)
                data = {"title": title, "lead": lead, "sections": [], "url": url}

                self._cache[query.lower()] = data

                return MechanismResult(
                    success=True,
                    data=data,
                    source_url=url,
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
            url = _page_url(title)

            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS, follow_redirects=True) as client:
                page_resp = await client.get(url)

            lead, sections = _parse_wiki_html(page_resp.text)
            if not lead:
                return MechanismResult(success=False, error="Failed to parse article body")

            return MechanismResult(
                success=True,
                data={"title": title, "lead": lead, "sections": sections, "url": url},
                source_url=url,
                source_title=f"Wikipedia - {title}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))
