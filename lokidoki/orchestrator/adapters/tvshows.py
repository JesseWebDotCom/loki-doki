"""Response adapter for TVMaze-backed TV show lookups."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class TVMazeAdapter:
    skill_id = "tvshows"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        name = str(data.get("name") or "").strip()
        summary_text = str(data.get("summary") or "").strip()
        status = str(data.get("status") or "").strip()
        premiered = str(data.get("premiered") or "").strip()
        rating = data.get("rating")
        genres = data.get("genres") or []
        network = str(data.get("network") or "").strip()

        if not name and not summary_text:
            return AdapterOutput(raw=data)

        facts: list[str] = []
        if premiered:
            year = premiered[:4]
            if year:
                facts.append(f"Premiered: {year}")
        if status:
            facts.append(f"Status: {status}")
        if isinstance(genres, list) and genres:
            labels = [str(g).strip() for g in genres if str(g).strip()]
            if labels:
                facts.append("Genre: " + ", ".join(labels))
        if network:
            facts.append(f"Network: {network}")
        if rating is not None:
            facts.append(f"Rating: {rating}")

        url = result.source_url or None
        source = Source(
            title=f"TVMaze: {name}" if name else "TVMaze",
            url=url,
            kind="web",
            snippet=summary_text or None,
        )

        return AdapterOutput(
            summary_candidates=(summary_text,) if summary_text else (),
            facts=tuple(facts),
            sources=(source,),
            raw=data,
        )
