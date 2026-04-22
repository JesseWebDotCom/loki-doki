"""Response adapter for DuckDuckGo-backed search results."""
from __future__ import annotations

import re

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _sentences(text: str, *, limit: int) -> tuple[str, ...]:
    parts = [part.strip() for part in _SENTENCE_SPLIT_RE.split(text) if part.strip()]
    return tuple(parts[:limit])


class DuckDuckGoAdapter:
    skill_id = "search"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        heading = str(data.get("heading") or result.source_title or "Search result").strip()
        abstract = str(data.get("abstract") or "").strip()
        rows = data.get("results") or []
        if not abstract and not rows and not result.source_url:
            return AdapterOutput(raw=data)

        sources: list[Source] = []
        if abstract or result.source_url:
            sources.append(
                Source(
                    title=heading,
                    url=result.source_url or None,
                    kind="web",
                    snippet=abstract or None,
                )
            )
        if isinstance(rows, list):
            for row in rows[:8]:
                snippet = str(row).strip()
                if not snippet:
                    continue
                title = snippet[:80].rstrip()
                sources.append(Source(title=title or "Search result", url=None, kind="web", snippet=snippet))

        summaries = (abstract,) if abstract else ()
        # Sentence-split the abstract into ``facts`` so rich-mode
        # turns (encyclopedic / people_lookup / …) get a populated
        # ``key_facts`` block. Mirrors :class:`WikipediaAdapter`.
        facts = _sentences(abstract, limit=5) if abstract else ()
        media: tuple[dict, ...] = ()
        # DuckDuckGo's instant-answer JSON surfaces a thumbnail in
        # ``Image`` for people / works / products. Use it verbatim
        # when present — falls back to no media silently, never
        # blocks the turn.
        image = str(data.get("Image") or "").strip()
        if image:
            image_url = image if image.startswith(("http://", "https://")) else f"https://duckduckgo.com{image}"
            media = ({
                "kind": "image",
                "url": image_url,
                "caption": heading,
                "source_label": "DuckDuckGo",
            },)
        return AdapterOutput(
            summary_candidates=summaries,
            facts=facts,
            sources=tuple(sources[:8]),
            media=media,
            raw=data,
        )
