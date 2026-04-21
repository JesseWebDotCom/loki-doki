"""Response adapter for jokes."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class JokesAdapter:
    skill_id = "jokes"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        joke = str(data.get("joke") or "").strip()
        if not joke:
            setup = str(data.get("setup") or "").strip()
            punchline = str(data.get("punchline") or "").strip()
            joke = " ".join(part for part in (setup, punchline) if part)
        if not joke:
            return AdapterOutput(raw=data)
        sources = ()
        if result.source_title or result.source_url:
            sources = (
                Source(
                    title=result.source_title or "Joke provider",
                    url=result.source_url or None,
                    kind="skill",
                ),
            )
        return AdapterOutput(summary_candidates=(joke,), sources=sources, raw=data)
