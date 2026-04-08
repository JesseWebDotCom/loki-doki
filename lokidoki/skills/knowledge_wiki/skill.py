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

# Soft cap for the verbatim path. The decomposer marks short factual
# lookups as response_shape=verbatim, which means the orchestrator emits
# our ``lead`` straight to the user with no synthesis filter. A full
# Wikipedia lead is 5+ paragraphs and reads as a wall of text in chat,
# so we trim to the first couple of sentences. The full extract still
# ships in the data dict; downstream synthesis can read more if it
# needs to.
VERBATIM_LEAD_CHAR_CAP = 600


def _trim_to_sentences(text: str, char_cap: int) -> str:
    """Return the first whole sentences of ``text`` within ``char_cap``.

    We never split mid-sentence — better to under-fill the budget than
    leave the user with a dangling clause. Falls back to the raw cap +
    ellipsis when no sentence boundary fits.
    """
    text = (text or "").strip()
    if len(text) <= char_cap:
        return text
    window = text[:char_cap]
    # Walk backward for the last sentence-ending punctuation followed by
    # a space (or end-of-window). This avoids cutting on abbreviations
    # like "U.S." mid-token.
    cut = -1
    for i in range(len(window) - 1, 0, -1):
        if window[i - 1] in ".!?" and (i == len(window) or window[i] == " "):
            cut = i
            break
    if cut > 0:
        return window[:cut].strip()
    return window.rsplit(" ", 1)[0] + "…"

# Junk title patterns we never want to surface as the canonical answer
# for a "who/what is X" question. "List of …" pages are aggregations,
# disambiguation pages are menus, and category/portal/template pages are
# meta. Wikipedia search ranks these high for short generic queries
# (e.g. "who is the current us president" → "List of presidents …"),
# so we have to filter them client-side.
_JUNK_TITLE_PREFIXES = ("list of ", "lists of ", "category:", "portal:", "template:", "wikipedia:")
_JUNK_TITLE_SUBSTRINGS = ("(disambiguation)", "(disambiguation page)")


def _is_junk_title(title: str) -> bool:
    low = (title or "").lower()
    if not low:
        return True
    if any(low.startswith(p) for p in _JUNK_TITLE_PREFIXES):
        return True
    if any(s in low for s in _JUNK_TITLE_SUBSTRINGS):
        return True
    return False


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
            # Two-step lookup: the decomposer hands us natural-language
            # phrases ("who is the active US president", typos and all),
            # not canonical Wikipedia page titles. ``titles=`` requires
            # an exact title match and returns ``missing`` for anything
            # else, so we resolve the canonical title via the search
            # endpoint first, then fetch the extract by that title.
            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS) as client:
                search_resp = await client.get(
                    WIKI_API_URL,
                    params={
                        "action": "query",
                        "list": "search",
                        "srsearch": query,
                        "format": "json",
                        # Pull a handful so we can walk past junk titles
                        # ("List of …", disambig, etc.) instead of being
                        # stuck with whatever Wikipedia ranked first.
                        "srlimit": 5,
                    },
                )
                if search_resp.status_code != 200:
                    return MechanismResult(
                        success=False,
                        error=f"Wikipedia search error: {search_resp.status_code}",
                    )
                results = search_resp.json().get("query", {}).get("search", [])
                resolved_title = next(
                    (r["title"] for r in results if not _is_junk_title(r.get("title", ""))),
                    None,
                )
                if not resolved_title:
                    return MechanismResult(success=False, error="No Wikipedia article found")

                response = await client.get(
                    WIKI_API_URL,
                    params={
                        "action": "query",
                        "titles": resolved_title,
                        "prop": "extracts",
                        "exintro": True,
                        "explaintext": True,
                        "format": "json",
                        "redirects": 1,
                    },
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"Wikipedia API error: {response.status_code}")

            pages = response.json().get("query", {}).get("pages", {})
            for page_id, page in pages.items():
                if page_id == "-1" or "missing" in page:
                    return MechanismResult(success=False, error="No Wikipedia article found")

                title = page.get("title", resolved_title)
                full_lead = (page.get("extract") or "").strip()
                if len(full_lead) > LEAD_CHAR_CAP:
                    full_lead = full_lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "…"
                # Verbatim path gets a sentence-bounded trim so we don't
                # dump 5 paragraphs of Wikipedia history at the user for
                # what was a one-line factual question.
                lead = _trim_to_sentences(full_lead, VERBATIM_LEAD_CHAR_CAP)
                url = _page_url(title)
                data = {
                    "title": title,
                    "lead": lead,
                    "extract": full_lead,
                    "sections": [],
                    "url": url,
                }

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
