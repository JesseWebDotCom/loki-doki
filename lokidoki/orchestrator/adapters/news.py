"""Response adapter for news headline payloads."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class NewsAdapter:
    skill_id = "news"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        headlines = data.get("headlines") or []
        if not isinstance(headlines, list) or not headlines:
            return AdapterOutput(raw=data)

        top = headlines[0] if isinstance(headlines[0], dict) else {}
        top_title = str(top.get("title") or "").strip()
        top_source = str(top.get("source") or "").strip()
        summary = f"{top_title} ({top_source})" if top_title and top_source else top_title
        facts: list[str] = []
        sources: list[Source] = []
        for item in headlines[:5]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            if not title:
                continue
            facts.append(title)
            sources.append(
                Source(
                    title=title,
                    url=str(item.get("link") or "").strip() or None,
                    kind="web",
                    snippet=title,
                    published_at=str(item.get("published") or "").strip() or None,
                    author=str(item.get("source") or "").strip() or None,
                )
            )
        if not summary and not facts:
            return AdapterOutput(raw=data)
        return AdapterOutput(
            summary_candidates=(summary,) if summary else (),
            facts=tuple(facts),
            sources=tuple(sources),
            raw=data,
        )
