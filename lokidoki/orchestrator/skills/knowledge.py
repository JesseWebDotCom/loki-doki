"""knowledge_query adapter — local-first, then parallel network lookup.

Flow:

1. Try local ZIM archives first (instant, offline). If the result
   scores above :data:`MIN_SUBJECT_COVERAGE`, return immediately —
   no network calls at all.

2. Only if ZIM misses or scores too low, fan out Wikipedia and
   DuckDuckGo in parallel and pick the best-scoring network result.

3. Ties are broken in favor of Wikipedia (first in the ``sources``
   list), which is the authoritative preference when both sources
   cover the subject equally.

4. If all sources score below :data:`MIN_SUBJECT_COVERAGE`, the skill
   fails and the LLM fallback handles the turn.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.knowledge.skill import HEADERS, WIKI_API_URL, WikipediaSkill

from lokidoki.orchestrator.skills._runner import (
    AdapterResult,
    run_mechanisms,
    run_sources_parallel_scored,
    score_subject_coverage,
    web_image_search_source,
    web_search_source,
)

_WIKI = WikipediaSkill()

# Minimum fraction of significant query tokens that must appear in a
# source's body for that source to be considered on-subject.
MIN_SUBJECT_COVERAGE = 0.5


def _extract_query(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    # Prefer the decomposer's pre-resolved query when present — the fast
    # LLM has already rewritten pronouns against the in-turn context
    # (e.g. "is it free" + prior-turn entity → "is Claude Cowork free").
    # This supersedes conversation_topic enrichment, which used to pull
    # in STALE topics ("The Dark Knight" from ten turns ago) when the
    # user asked a follow-up like "how do I do that" about a brand-new
    # medical question.
    resolved = str(payload.get("resolved_query") or "").strip()
    if resolved:
        return resolved
    base = str(payload.get("chunk_text") or "").strip(" ?.!")
    # Conversation-topic enrichment is gated behind "no decomposer
    # signal at all" — otherwise we'd keep poisoning follow-ups with
    # unrelated earlier topics.
    if payload.get("capability_need"):
        return base
    topic = str(payload.get("conversation_topic") or "").strip()
    if topic and base and topic.lower() not in base.lower():
        words = base.split()
        if len(words) <= 4:
            base = f"{base} {topic}"
    return base


def _format_wiki(result, method: str) -> str:
    """Reduce a WikipediaSkill MechanismResult to a one-paragraph answer."""
    data = result.data or {}
    lead = str(data.get("lead") or "").strip()
    if lead:
        return lead
    extract = str(data.get("extract") or "").strip()
    if extract:
        first = extract.split(". ", 1)[0].rstrip(".")
        return f"{first}."
    title = str(data.get("title") or "").strip()
    if title:
        return f"I found a Wikipedia article on {title} but couldn't extract a summary."
    return "I couldn't extract a Wikipedia summary for that."


import re

_QUESTION_PREFIX = re.compile(
    r"^(?:who\s+(?:is|was|are|were)|what\s+(?:is|was|are|were|'s))\s+",
    re.IGNORECASE,
)


def _zim_query(query: str) -> str:
    """Strip question prefixes so ZIM title-suggestion matching works.

    "who is corey feldman" → "corey feldman" — gives the title
    suggestion engine a prefix that matches the article title directly,
    instead of falling through to full-text search which may rank a
    tangentially related article higher.
    """
    return _QUESTION_PREFIX.sub("", query).strip() or query


async def _zim_source(
    query: str,
    archive_hint: str = "",
    capability_need: str = "",
) -> AdapterResult:
    """Query local ZIM archives — fastest, offline-first path.

    When the decomposer supplies an ``archive_hint`` or a
    topic-specific ``capability_need`` (medical, howto, etc.), search
    is scoped to the matching source family first — so "chest pain"
    lands in MedlinePlus/WikEM instead of surfacing a loose Wikipedia
    match. Falls back to searching all loaded archives when the hinted
    sources aren't installed or return no results.

    Each candidate is gated by title relevance (junk prefixes rejected,
    at least one significant query token must appear in the title or a
    literal substring for very short queries) BEFORE snippet coverage
    is scored. Snippet-only scoring used to let wildly off-topic
    articles win when the query words appeared inside an example
    sentence (the "Procedural knowledge" Wikipedia article matching
    "how do I change a flat tire" because the article cites that
    phrase as an example of procedural knowledge).
    """
    try:
        from lokidoki.archives.hint_map import filter_to_loaded, sources_for_hint
        from lokidoki.archives.search import get_search_engine
        from lokidoki.skills.knowledge._parse import (
            _is_junk_title,
            _title_substantially_matches,
        )

        engine = get_search_engine()
        if engine is None or not engine.loaded_sources:
            return AdapterResult(
                output_text="", success=False, error="no ZIM archives loaded",
            )
        clean = _zim_query(query)

        def _title_ok(title: str) -> bool:
            # Same relevance rule the network Wikipedia paths use —
            # rejects junk prefixes (Portal:, Category:, …) and titles
            # that share fewer than ⌈n/2⌉ significant tokens with the
            # query (both tokens for 1–2 token queries).
            return (
                not _is_junk_title(title)
                and _title_substantially_matches(title, query)
            )

        # Resolve hint → concrete loaded source subset. Empty means
        # "search everything" (caller-side default).
        hinted = sources_for_hint(archive_hint, capability_need)
        scoped = filter_to_loaded(hinted, engine.loaded_sources) if hinted else []

        # Pull a few candidates up-front so the title gate has material
        # to work with. A single top-1 is too easy to mismatch on
        # example-text hits.
        results = await engine.search(clean, sources=scoped or None, max_results=8)

        # If hinted search came up empty, fall back to all-loaded — better
        # to surface an off-scope hit than fail entirely.
        if not results and scoped:
            results = await engine.search(clean, max_results=8)

        on_topic = [r for r in results if _title_ok(r.title)]
        if not on_topic:
            return AdapterResult(
                output_text="", success=False, error="no local article found",
            )

        best = max(on_topic, key=lambda r: score_subject_coverage(query, r.snippet))
        if score_subject_coverage(query, best.snippet) < MIN_SUBJECT_COVERAGE:
            return AdapterResult(
                output_text="", success=False, error="no local article found",
            )
        # Populate ``data`` so the response-layer WikipediaAdapter has
        # a ``lead`` / ``title`` / ``extract`` to work with — without
        # it the adapter gets an empty dict and the rich-response
        # ``key_facts`` block stays empty.
        media = await _zim_article_media(engine, best)
        data: dict[str, Any] = {
            "title": best.title,
            "lead": best.snippet,
            "extract": best.snippet,
            "url": best.url,
        }
        if media:
            data["media"] = media
        return AdapterResult(
            output_text=best.snippet,
            success=True,
            source_url=best.url,
            source_title=f"{best.source_label} (offline)",
            data=data,
        )
    except Exception as exc:
        return AdapterResult(
            output_text="", success=False, error=str(exc),
        )


_MAX_MEDIA_CARDS = 3


async def _zim_article_media(engine, article) -> list[dict[str, Any]]:
    """Collect up to :data:`_MAX_MEDIA_CARDS` image cards for a ZIM article.

    Layered source strategy (each layer only runs if there's room left
    in the media budget):

    1. ZIM-embedded ``<img>`` tags. Maxi builds carry the image bytes
       on disk; we rewrite the src to the local asset route so the
       browser never reaches Commons.
    2. MediaWiki ``pageimages`` thumbnail. Fills the canonical portrait
       when the ZIM is a mini / nopic build but the Pi has network.
    3. Generic web-image-search fallback. Fills remaining slots for
       variety (3 images total) or covers articles where Wikipedia has
       no lead image (e.g. ``Robert Z'Dar``) — and covers "what is a
       lug nut" shape queries where visual grounding helps. Uses the
       shared :func:`web_image_search_source` so the same plumbing
       picks up whichever web-search skill is active.

    Every layer fails silently — no layer is allowed to break the turn.
    """
    cards: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    def _push(card: dict[str, Any]) -> bool:
        url = str(card.get("url") or "").strip()
        if not url or url in seen_urls:
            return False
        seen_urls.add(url)
        cards.append(card)
        return len(cards) >= _MAX_MEDIA_CARDS

    # Layer 1 — embedded ZIM images.
    try:
        from lokidoki.skills.knowledge._parse import parse_wiki_images

        html = await engine.get_article_html(article.source_id, article.path)
        if html:
            for img in parse_wiki_images(html, limit=_MAX_MEDIA_CARDS):
                full = _push({
                    "kind": "image",
                    "url": f"/api/v1/archives/media/{article.source_id}/{img['src']}",
                    "caption": str(img.get("alt") or article.title),
                    "source_label": article.source_label,
                })
                if full:
                    return cards
    except Exception:  # noqa: BLE001 - image extraction must never break the turn
        pass

    # Layer 2 — Wikipedia canonical portrait (only for Wikipedia-family
    # ZIM sources, so wikem / appropedia / osm-wiki don't get
    # misattributed images).
    if article.source_id.startswith("wikipedia"):
        try:
            thumb = await _wiki_thumbnail(article.title)
            if thumb:
                full = _push({
                    "kind": "image",
                    "url": thumb,
                    "caption": article.title,
                    "source_label": "Wikipedia",
                })
                if full:
                    return cards
        except Exception:  # noqa: BLE001
            pass

    # Layer 3 — generic web image search.
    remaining = _MAX_MEDIA_CARDS - len(cards)
    if remaining > 0:
        try:
            extras = await web_image_search_source(article.title, limit=remaining)
            for card in extras:
                full = _push(card)
                if full:
                    break
        except Exception:  # noqa: BLE001
            pass

    return cards


async def _wiki_thumbnail(title: str) -> str:
    """Fetch a single thumbnail URL from MediaWiki's ``pageimages`` API.

    Returns the thumbnail URL on success, empty string on any failure.
    Timeout is aggressive (2 s) so an offline Pi never blocks a turn on
    a DNS retry. The URL returned is Wikipedia's own CDN; the browser
    loads it directly — same boundary the article path already uses.
    """
    if not title:
        return ""
    try:
        import httpx

        async with httpx.AsyncClient(timeout=2.0, headers=HEADERS) as client:
            resp = await client.get(
                WIKI_API_URL,
                params={
                    "action": "query",
                    "titles": title,
                    "prop": "pageimages",
                    "piprop": "thumbnail",
                    "pithumbsize": 400,
                    "format": "json",
                    "redirects": 1,
                },
            )
        if resp.status_code != 200:
            return ""
        pages = resp.json().get("query", {}).get("pages", {}) or {}
        for page in pages.values():
            thumb = (page.get("thumbnail") or {}).get("source") or ""
            if thumb:
                return str(thumb)
    except Exception:  # noqa: BLE001 - offline / DNS failure must not break the turn
        return ""
    return ""


async def _wiki_source(query: str) -> AdapterResult:
    return await run_mechanisms(
        _WIKI,
        [
            ("mediawiki_api", {"query": query}),
            ("web_scraper", {"query": query}),
        ],
        on_success=_format_wiki,
        on_all_failed=f"Wikipedia had nothing on '{query}'.",
    )


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    query = _extract_query(payload)
    if not query:
        return AdapterResult(
            output_text="What would you like to know more about?",
            success=False,
            error="missing query",
        ).to_payload()

    archive_hint = str(payload.get("archive_hint") or "")
    capability_need = str(payload.get("capability_need") or "")

    def score(result: AdapterResult) -> float:
        return score_subject_coverage(query, result.output_text)

    # ── Local-first: try ZIM archives before any network call ──
    zim_result = await _zim_source(query, archive_hint, capability_need)
    if zim_result.success and score(zim_result) >= MIN_SUBJECT_COVERAGE:
        return zim_result.to_payload()

    # ── ZIM missed — fall back to parallel network sources ──
    result = await run_sources_parallel_scored(
        [
            ("wikipedia", _wiki_source(query)),
            ("web", web_search_source(query)),
        ],
        score=score,
        threshold=MIN_SUBJECT_COVERAGE,
        fallback_text=(
            f"I couldn't find anything on '{query}' right now — "
            "neither Wikipedia nor web search returned a relevant article."
        ),
    )
    return result.to_payload()
