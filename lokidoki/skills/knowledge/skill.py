"""Wikipedia knowledge skill.

Both mechanisms return a normalized payload:
    {"title": str, "lead": str, "sections": list[str], "url": str}

`lead` is the article's lead section (intro paragraphs before the first
section header). `sections` is a manifest of top-level section titles so
the orchestrator can offer follow-ups without re-fetching.
"""
from __future__ import annotations

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

from lokidoki.skills.knowledge._parse import (
    LEAD_CHAR_CAP,
    VERBATIM_LEAD_CHAR_CAP,
    _is_junk_title,
    _page_url,
    _query_tokens,
    _strip_diacritics,
    _title_matches_query,
    _title_substantially_matches,
    _trim_to_sentences,
    parse_wiki_html,
)

WIKI_API_URL = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "LokiDoki/0.1 (https://github.com/lokidoki; local assistant) httpx"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


class WikipediaSkill(BaseSkill):
    """Fetches knowledge from Wikipedia via MediaWiki API or HTML scraping."""

    def __init__(self):
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "zim_local":
            return await self._zim_local(parameters)
        elif method == "mediawiki_api":
            return await self._mediawiki_api(parameters)
        elif method == "web_scraper":
            return await self._web_scraper(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _zim_local(self, parameters: dict) -> MechanismResult:
        """Query local ZIM archives. Fastest path — no network needed."""
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            from lokidoki.archives.search import get_search_engine

            engine = get_search_engine()
            if engine is None or not engine.loaded_sources:
                return MechanismResult(success=False, error="No ZIM archives loaded")

            # Ask for a handful and filter. Raw top-1 frequently surfaces
            # junk titles (``Portal:Illinois``) or articles that share no
            # meaningful tokens with the query (``Procedural knowledge``
            # for "how do I change a flat tire"). Apply the same relevance
            # gate the MediaWiki path uses so the orchestrator's offline
            # fast-path never dumps a wildly off-topic article.
            results = await engine.search(query, max_results=8)
            if not results:
                return MechanismResult(success=False, error="No local article found")

            # The shared ``_title_matches_query`` helper returns True when
            # the query has no significant tokens (its "generic fallback"
            # branch). That's sensible for the MediaWiki path where the
            # top result is already ranked by Wikipedia, but it lets the
            # ZIM path leak wildly off-topic articles for short
            # procedural asks where every word is filtered as short or
            # stopword ("how do I give cpr"). Require real overlap here
            # and fall back to a token-containment check so the skill
            # fails cleanly and lets the LLM synthesis path answer.
            q_tokens = _query_tokens(query)
            def _is_relevant(title: str) -> bool:
                if _is_junk_title(title):
                    return False
                if q_tokens:
                    return bool(q_tokens & _query_tokens(title))
                # Every query token was too short/common for the overlap
                # helper. Fall back to substring containment so a hit is
                # only accepted when the title literally mentions the ask.
                lt = title.lower()
                return any(word.lower() in lt for word in query.split() if len(word) >= 3)

            article = next((r for r in results if _is_relevant(r.title)), None)
            if article is None:
                return MechanismResult(
                    success=False, error="No relevant local article found"
                )
            lead = _trim_to_sentences(article.snippet, VERBATIM_LEAD_CHAR_CAP)
            data = {
                "title": article.title,
                "lead": lead,
                "extract": article.snippet,
                "sections": [],
                "url": article.url,
            }
            self._cache[query.lower()] = data
            return MechanismResult(
                success=True,
                data=data,
                source_url=article.url,
                source_title=f"{article.source_label} (offline) - {article.title}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    async def _mediawiki_api(self, parameters: dict) -> MechanismResult:
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
                    (
                        r["title"] for r in results
                        if not _is_junk_title(r.get("title", ""))
                        and _title_substantially_matches(r.get("title", ""), query)
                    ),
                    None,
                )
                if not resolved_title:
                    return MechanismResult(
                        success=False,
                        error="No relevant Wikipedia article found",
                    )

                response = await client.get(
                    WIKI_API_URL,
                    params={
                        "action": "query",
                        "titles": resolved_title,
                        # ``pageimages`` surfaces the article's canonical
                        # thumbnail (infobox portrait). Bootstrap is still
                        # the only install boundary; this live fetch runs
                        # only when the user chose NOT to mirror Wikipedia
                        # as a ZIM, and is the same network boundary the
                        # lead-text fetch is already crossing.
                        "prop": "extracts|pageimages",
                        "exintro": True,
                        "explaintext": True,
                        "piprop": "thumbnail|original",
                        "pithumbsize": 400,
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
                    full_lead = full_lead[:LEAD_CHAR_CAP].rsplit(" ", 1)[0] + "\u2026"
                lead = _trim_to_sentences(full_lead, VERBATIM_LEAD_CHAR_CAP)
                url = _page_url(title)
                data = {
                    "title": title,
                    "lead": lead,
                    "extract": full_lead,
                    "sections": [],
                    "url": url,
                }
                thumb = page.get("thumbnail") or {}
                thumb_url = str(thumb.get("source") or "").strip()
                if thumb_url:
                    data["media"] = [{
                        "kind": "image",
                        "url": thumb_url,
                        "caption": title,
                        "source_label": "Wikipedia",
                    }]

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
                        "srlimit": 5,
                    },
                )

            if search_resp.status_code != 200:
                return MechanismResult(success=False, error=f"Wikipedia search error: {search_resp.status_code}")

            results = search_resp.json().get("query", {}).get("search", [])
            if not results:
                return MechanismResult(success=False, error="No search results found")

            title = next(
                (
                    r["title"] for r in results
                    if not _is_junk_title(r.get("title", ""))
                    and _title_substantially_matches(r.get("title", ""), query)
                ),
                None,
            )
            if not title:
                return MechanismResult(
                    success=False,
                    error="No relevant Wikipedia article found",
                )
            url = _page_url(title)

            async with httpx.AsyncClient(timeout=5.0, headers=HEADERS, follow_redirects=True) as client:
                page_resp = await client.get(url)

            lead, sections = parse_wiki_html(page_resp.text)
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
