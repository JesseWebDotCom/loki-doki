"""Response adapter for Wikipedia-backed movie lookups.

The payload shape mirrors ``movies_wiki.skill`` output: a lead one-liner,
an ``overview`` extract, plus release/runtime/genre facts. Structurally
similar to :class:`WikipediaAdapter` but with movie-specific facts.
"""
from __future__ import annotations

import re

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _first_sentence(text: str) -> str:
    for part in _SENTENCE_SPLIT_RE.split(text):
        part = part.strip()
        if part:
            return part
    return ""


class WikiMoviesAdapter:
    skill_id = "movies_wiki"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        title = str(data.get("title") or "").strip()
        lead = str(data.get("lead") or "").strip()
        overview = str(data.get("overview") or "").strip()
        release = str(data.get("release_date") or "").strip()
        runtime = data.get("runtime_min")
        genre = str(data.get("genre") or "").strip()
        url = result.source_url or None

        if not title and not lead and not overview:
            return AdapterOutput(raw=data)

        summary = lead or overview
        summary_candidates = (summary,) if summary else ()

        facts: list[str] = []
        if release:
            year = release[:4]
            if year:
                facts.append(f"Released: {year}")
        if runtime:
            facts.append(f"Runtime: {runtime} min")
        if genre:
            facts.append(f"Genre: {genre}")

        snippet = _first_sentence(overview) or None
        source = Source(
            title=f"Wikipedia — {title}" if title else "Wikipedia",
            url=url,
            kind="web",
            snippet=snippet,
        )

        return AdapterOutput(
            summary_candidates=summary_candidates,
            facts=tuple(facts),
            sources=(source,),
            raw=data,
        )
