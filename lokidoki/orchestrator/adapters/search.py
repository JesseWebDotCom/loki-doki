"""Response adapter for DuckDuckGo-backed search results."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


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
        return AdapterOutput(summary_candidates=summaries, sources=tuple(sources[:8]), raw=data)
