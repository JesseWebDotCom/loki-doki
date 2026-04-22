"""Response adapter for the people-lookup skill.

The skill searches the local relationship graph (``people_rows`` +
``relationships``) and returns either matched people or a
clarification request. The adapter surfaces the matches as facts and
the formatted ``lead`` as the summary candidate.
"""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class PeopleLookupAdapter:
    skill_id = "people_lookup"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        if data.get("needs_clarification"):
            prompt = str(data.get("clarification_prompt") or "").strip()
            summary = (prompt,) if prompt else ()
            return AdapterOutput(summary_candidates=summary, raw=data)

        matches = data.get("matches") or []
        lead = str(data.get("lead") or "").strip()
        if not isinstance(matches, list) or not matches:
            return AdapterOutput(raw=data)

        facts: list[str] = []
        for entry in matches[:8]:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()
            if not name:
                continue
            relations_raw = entry.get("relations") or []
            relations: list[str] = []
            if isinstance(relations_raw, list):
                relations = [str(r).strip() for r in relations_raw if str(r).strip()]
            bucket = str(entry.get("bucket") or "").strip()
            labels: list[str] = []
            if relations:
                labels.extend(relations)
            if bucket and bucket not in labels:
                labels.append(bucket)
            fact = f"{name} ({', '.join(labels)})" if labels else name
            facts.append(fact)

        summary: tuple[str, ...]
        if lead:
            summary = (lead,)
        elif facts:
            summary = (facts[0],)
        else:
            summary = ()

        sources: tuple[Source, ...] = ()
        if result.source_url or result.source_title:
            sources = (
                Source(
                    title=result.source_title or "People graph",
                    url=result.source_url or None,
                    kind="local",
                ),
            )

        return AdapterOutput(
            summary_candidates=summary,
            facts=tuple(facts),
            sources=sources,
            raw=data,
        )
