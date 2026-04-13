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
   - ``web`` — :class:`DuckDuckGoSkill` with its own internal
     ``ddg_api`` → ``ddg_scraper`` waterfall.

2. When both settle, each successful result is scored by
   :func:`_score_subject_coverage` — the fraction of the query's
   significant tokens that actually appear in the source's body text.
   A query about ``"claude mythos"`` against Wikipedia's ``"Claude"``
   article scores 0.5 (only ``claude`` is present, not ``mythos``),
   while the same query against a web snippet that literally discusses
   Claude Mythos scores 1.0. The higher-scoring source wins.

3. Ties are broken in favor of Wikipedia (first in the ``sources``
   list), which is the authoritative preference when both sources
   cover the subject equally.

4. If both sources score below :data:`MIN_SUBJECT_COVERAGE`, the skill
   fails and the LLM fallback handles the turn ("I don't have info on
   that") — much better than grounding synthesis on a wrong article.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.knowledge_wiki.skill import (
    WikipediaSkill,
    _query_tokens,
    _strip_diacritics,
)
from lokidoki.skills.search_ddg.skill import DuckDuckGoSkill

from lokidoki.orchestrator.skills._runner import (
    AdapterResult,
    run_mechanisms,
    run_sources_parallel_scored,
)

_WIKI = WikipediaSkill()
_DDG = DuckDuckGoSkill()

# Minimum fraction of significant query tokens that must appear in a
# source's body for that source to be considered on-subject. Set to
# 0.5 so single-token queries must match exactly (1/1 = 1.0 ≥ 0.5),
# two-token queries must match at least one (1/2 = 0.5 ≥ 0.5), and
# three-token queries must match at least two (2/3 ≈ 0.67 ≥ 0.5).
# Below this the source gets dropped in favor of the other, or the
# skill fails and hands off to the LLM.
MIN_SUBJECT_COVERAGE = 0.5


def _extract_query(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    return str(payload.get("chunk_text") or "").strip(" ?.!")


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


def _format_ddg(result, method: str) -> str:
    """Reduce a DuckDuckGoSkill MechanismResult to a one-paragraph answer.

    DDG instant-answers surface as ``abstract``; the HTML scraper
    returns a list of ``results`` snippets. We prefer the abstract
    when present, then join the top 3 snippets.
    """
    data = result.data or {}
    abstract = str(data.get("abstract") or "").strip()
    if abstract:
        return abstract
    results = data.get("results") or []
    cleaned = [str(item).strip() for item in results[:3] if str(item).strip()]
    if cleaned:
        return " ".join(cleaned)
    return "I couldn't find a web snippet for that."


def _score_subject_coverage(query: str, body: str) -> float:
    """Fraction of significant query tokens present in ``body``.

    Uses the same tokenizer as the Wikipedia title gate so the notion
    of "significant token" stays consistent across the module:
    4+ characters, non-stopword, diacritics folded. Empty token sets
    short-circuit to 1.0 — if the query has no discriminating content
    words (e.g. "hi"), we trust whichever source returned something.
    """
    q_tokens = _query_tokens(query)
    if not q_tokens:
        return 1.0
    body_norm = _strip_diacritics((body or "").lower())
    present = sum(1 for token in q_tokens if token in body_norm)
    return present / len(q_tokens)


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


async def _ddg_source(query: str) -> AdapterResult:
    return await run_mechanisms(
        _DDG,
        [
            ("ddg_api", {"query": query}),
            ("ddg_scraper", {"query": query}),
        ],
        on_success=_format_ddg,
        on_all_failed=f"Web search had nothing on '{query}'.",
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
        # Score against the same body text the caller would show the
        # user — that's what _format_wiki / _format_ddg produced.
        return _score_subject_coverage(query, result.output_text)

    result = await run_sources_parallel_scored(
        [
            ("wikipedia", _wiki_source(query)),
            ("web", _ddg_source(query)),
        ],
        score=score,
        threshold=MIN_SUBJECT_COVERAGE,
        fallback_text=(
            f"I couldn't find anything on '{query}' right now — "
            "neither Wikipedia nor web search returned a relevant article."
        ),
    )
    return result.to_payload()
