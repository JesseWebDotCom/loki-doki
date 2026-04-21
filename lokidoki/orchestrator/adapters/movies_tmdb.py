"""Response adapter for TMDB movie payloads."""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


_POSTER_BASE = "https://image.tmdb.org/t/p/w500"


class TMDBAdapter:
    skill_id = "movies_tmdb"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        title = str(data.get("title") or "").strip()
        overview = str(data.get("overview") or "").strip()
        release = str(data.get("release_date") or "").strip()
        rating = data.get("rating")
        runtime = data.get("runtime") or data.get("runtime_min")
        cast = data.get("cast") or []
        poster_path = str(data.get("poster_path") or "").strip()
        poster_url = str(data.get("poster_url") or "").strip()

        if not title and not overview:
            return AdapterOutput(raw=data)

        facts: list[str] = []
        year = release[:4] if release else ""
        if year:
            facts.append(f"Released: {year}")
        if runtime:
            facts.append(f"Runtime: {runtime} min")
        if rating is not None:
            facts.append(f"Rating: {rating}")
        if isinstance(cast, list):
            top_cast = [str(c).strip() for c in cast[:2] if str(c).strip()]
            if top_cast:
                facts.append("Cast: " + ", ".join(top_cast))

        source = Source(
            title=f"TMDB: {title}" if title else "TMDB",
            url=result.source_url or None,
            kind="web",
            snippet=overview or None,
        )

        media: tuple[dict, ...] = ()
        final_poster = poster_url or (f"{_POSTER_BASE}{poster_path}" if poster_path else "")
        if final_poster:
            poster_card: dict = {"kind": "poster", "url": final_poster}
            if title:
                poster_card["title"] = title
            media = (poster_card,)

        return AdapterOutput(
            summary_candidates=(overview,) if overview else (),
            facts=tuple(facts),
            sources=(source,),
            media=media,
            raw=data,
        )
