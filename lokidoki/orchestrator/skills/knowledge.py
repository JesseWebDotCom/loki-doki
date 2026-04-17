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


async def _zim_source(query: str) -> AdapterResult:
    """Query local ZIM archives — fastest, offline-first path.

    Optimized two-pass strategy:
    1. Search with max_results=1 (fast — title suggestion usually nails it).
    2. If that result scores well, return immediately.
    3. If not, widen to 3 results and pick the best scorer.
    """
    try:
        from lokidoki.archives.search import get_search_engine

        engine = get_search_engine()
        if engine is None or not engine.loaded_sources:
            return AdapterResult(
                output_text="", success=False, error="no ZIM archives loaded",
            )
        clean = _zim_query(query)

        # Fast path: single best result
        results = await engine.search(clean, max_results=1)
        if not results:
            return AdapterResult(
                output_text="", success=False, error="no local article found",
            )
        best = results[0]
        if score_subject_coverage(query, best.snippet) >= MIN_SUBJECT_COVERAGE:
            return AdapterResult(
                output_text=best.snippet,
                success=True,
                source_url=best.url,
                source_title=f"{best.source_label} (offline)",
            )

        # Wider search when first result is off-subject
        results = await engine.search(clean, max_results=3)
        best = max(results, key=lambda r: score_subject_coverage(query, r.snippet))
        return AdapterResult(
            output_text=best.snippet,
            success=True,
            source_url=best.url,
            source_title=f"{best.source_label} (offline)",
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

    # ── Local-first: try ZIM archives before any network call ──
    zim_result = await _zim_source(query)
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
