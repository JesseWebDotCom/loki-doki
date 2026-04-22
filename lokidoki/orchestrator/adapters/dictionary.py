"""Response adapter for dictionary lookups."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class DictionaryAdapter:
    skill_id = "dictionary"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        word = str(data.get("word") or "").strip()
        meanings = data.get("meanings") or []
        if not isinstance(meanings, list) or not meanings:
            return AdapterOutput(raw=data)

        summaries: list[str] = []
        facts: list[str] = []
        follow_ups: list[str] = []
        for meaning in meanings[:3]:
            if not isinstance(meaning, dict):
                continue
            part = str(meaning.get("part_of_speech") or "").strip()
            definitions = meaning.get("definitions") or []
            if not isinstance(definitions, list) or not definitions:
                continue
            primary = str(definitions[0] or "").strip()
            if not primary:
                continue
            prefix = f"{word} ({part})" if word and part else word or part
            summaries.append(f"{prefix}: {primary}" if prefix else primary)
            facts.append(f"{part}: {primary}" if part else primary)
            if meaning.get("synonyms"):
                follow_ups.append("See synonyms")
            if meaning.get("examples"):
                follow_ups.append("See examples")

        if not summaries and not facts:
            return AdapterOutput(raw=data)

        source = Source(
            title=result.source_title or "Dictionary",
            url=result.source_url or None,
            kind="skill",
        )
        return AdapterOutput(
            summary_candidates=tuple(summaries),
            facts=tuple(facts),
            sources=(source,),
            follow_up_candidates=tuple(dict.fromkeys(follow_ups)),
            raw=data,
        )
