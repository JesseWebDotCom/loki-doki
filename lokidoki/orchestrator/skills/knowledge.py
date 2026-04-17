"""knowledge_query adapter — parallel Wikipedia + web-search lookup.

Wikipedia is authoritative on canonical, established topics. Web search
catches novel, niche, or branded things Wikipedia has no page for. The
two are complementary, not redundant — which is why this adapter runs
both in parallel and scores each result against the user's query
instead of waterfall-falling from one to the other.

Flow:

1. Kick off two independent sources concurrently:
   - ``wikipedia`` — :class:`WikipediaSkill` with its own internal
     ``mediawiki_api`` → ``web_scraper`` waterfall.
   - ``web`` — shared :func:`web_search_source` (DuckDuckGo) from
     ``_runner``.

2. When both settle, each successful result is scored by
   :func:`score_subject_coverage` — the fraction of the query's
   significant tokens that actually appear in the source's body text.

3. Ties are broken in favor of Wikipedia (first in the ``sources``
   list), which is the authoritative preference when both sources
   cover the subject equally.

4. If both sources score below :data:`MIN_SUBJECT_COVERAGE`, the skill
   fails and the LLM fallback handles the turn.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.knowledge.skill import WikipediaSkill

from lokidoki.orchestrator.skills._runner import (
    AdapterResult,
    run_mechanisms,
    run_sources_parallel_scored,
    score_subject_coverage,
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
    base = str(payload.get("chunk_text") or "").strip(" ?.!")
    # Enrich very short, pronoun-heavy queries with the conversational
    # topic so "is it free" + topic "Claude Cowork" → "is it free
    # Claude Cowork". Cap at 4 words — anything longer already has
    # enough specificity to search on its own. A 7-word cap caused
    # "who is the active us president" (7 words) to get "what's
    # happening" appended from a stale prior turn's topic.
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


async def _zim_source(query: str) -> AdapterResult:
    """Query local ZIM archives — fastest, offline-first path."""
    try:
        from lokidoki.archives.search import get_search_engine

        engine = get_search_engine()
        if engine is None or not engine.loaded_sources:
            return AdapterResult(
                output_text="", success=False, error="no ZIM archives loaded",
            )
        results = await engine.search(query, max_results=1)
        if not results:
            return AdapterResult(
                output_text="", success=False, error="no local article found",
            )
        article = results[0]
        return AdapterResult(
            output_text=article.snippet,
            success=True,
            source_url=article.url,
            source_title=f"{article.source_label} (offline)",
        )
    except Exception as exc:
        return AdapterResult(
            output_text="", success=False, error=str(exc),
        )


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

    def score(result: AdapterResult) -> float:
        return score_subject_coverage(query, result.output_text)

    result = await run_sources_parallel_scored(
        [
            ("zim", _zim_source(query)),
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
