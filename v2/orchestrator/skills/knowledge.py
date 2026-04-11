"""v2 knowledge_query adapter — wraps lokidoki.skills.knowledge_wiki.

The v1 WikipediaSkill exposes two mechanisms:

  - ``mediawiki_api`` — search → fetch lead extract via the public API
  - ``web_scraper``  — scrape the same content out of rendered HTML

Adapter walks them in priority order. The v1 result already contains a
sentence-trimmed ``lead`` field — that's exactly what we want for the
v2 ``output_text``.
"""
from __future__ import annotations

from typing import Any

from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = WikipediaSkill()


def _extract_query(payload: dict[str, Any]) -> str:
    explicit = (payload.get("params") or {}).get("query")
    if explicit:
        return str(explicit)
    return str(payload.get("chunk_text") or "").strip(" ?.!")


def _format_success(result, method: str) -> str:
    data = result.data or {}
    lead = str(data.get("lead") or "").strip()
    if lead:
        return lead
    extract = str(data.get("extract") or "").strip()
    if extract:
        # Trim to first sentence-ish for a verbatim-shaped response.
        first = extract.split(". ", 1)[0].rstrip(".")
        return f"{first}."
    title = str(data.get("title") or "").strip()
    if title:
        return f"I found a Wikipedia article on {title} but couldn't extract a summary."
    return "I couldn't find anything on that."


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    query = _extract_query(payload)
    if not query:
        return AdapterResult(
            output_text="What would you like to know more about?",
            success=False,
            error="missing query",
        ).to_payload()
    attempts = [
        ("mediawiki_api", {"query": query}),
        ("web_scraper", {"query": query}),
    ]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed=(
            f"I couldn't find anything on '{query}' right now — Wikipedia "
            "didn't return a relevant article."
        ),
    )
    return result.to_payload()
