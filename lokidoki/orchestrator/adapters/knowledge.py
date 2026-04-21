"""Response adapter for Wikipedia-backed knowledge lookups."""
from __future__ import annotations

import re

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _sentences(text: str, *, limit: int) -> tuple[str, ...]:
    parts = [part.strip() for part in _SENTENCE_SPLIT_RE.split(text) if part.strip()]
    return tuple(parts[:limit])


class WikipediaAdapter:
    skill_id = "knowledge"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        lead = str(data.get("lead") or data.get("extract") or "").strip()
        title = str(data.get("title") or result.source_title or "").strip()
        url = str(data.get("url") or result.source_url or "").strip() or None
        if not lead and not title:
            return AdapterOutput(raw=data)
        source = Source(
            title=title or "Wikipedia",
            url=url,
            kind="web",
            snippet=_sentences(lead, limit=1)[0] if lead else None,
        )
        return AdapterOutput(
            summary_candidates=(lead,) if lead else (),
            facts=_sentences(lead, limit=5),
            sources=(source,),
            raw=data,
        )
