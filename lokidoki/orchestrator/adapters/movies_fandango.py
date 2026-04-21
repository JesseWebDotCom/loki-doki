"""Response adapter for Fandango showtimes payloads.

Fandango results are multi-shape — the ``list_now_playing`` /
``napi_theaters_with_showtimes`` tier returns a showtimes list, while
``movie_overview`` returns a single-movie detail payload. This adapter
handles the showtimes-list shape (the most common tier); single-movie
overviews carry their own ``lead`` and get normalized through a thin
pass-through.
"""
from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source


class FandangoShowtimesAdapter:
    skill_id = "movies_fandango"

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        data = result.data or {}
        showtimes = data.get("showtimes")
        movies = data.get("movies")
        location = str(data.get("location") or "").strip()
        lead = str(data.get("lead") or "").strip()

        # movie_overview shape — single-movie detail payload with a
        # title but no showtime/movie arrays.
        if (
            data.get("title")
            and not isinstance(showtimes, list)
            and not isinstance(movies, list)
        ):
            title = str(data["title"]).strip()
            overview_lead = lead or title
            src = Source(
                title=f"Fandango — {title}",
                url=result.source_url or None,
                kind="web",
            )
            return AdapterOutput(
                summary_candidates=(overview_lead,) if overview_lead else (),
                sources=(src,),
                raw=data,
            )

        facts: list[str] = []
        sources: list[Source] = []

        if isinstance(showtimes, list):
            for entry in showtimes[:8]:
                if not isinstance(entry, dict):
                    continue
                title = str(entry.get("title") or "").strip()
                if not title:
                    continue
                theaters = entry.get("theaters") or []
                first_theater = theaters[0] if isinstance(theaters, list) and theaters else None
                theater_name = ""
                time_slot = ""
                if isinstance(first_theater, dict):
                    theater_name = str(first_theater.get("name") or "").strip()
                    times = first_theater.get("times") or []
                    if isinstance(times, list) and times:
                        time_slot = str(times[0]).strip()
                snippet = str(entry.get("snippet") or "").strip()
                bits: list[str] = [title]
                if theater_name:
                    bits.append(theater_name)
                if time_slot:
                    bits.append(time_slot)
                facts.append(" — ".join(bits))
                showtime_url = str(entry.get("url") or "").strip() or None
                src_title = f"{theater_name}: {title}" if theater_name else title
                sources.append(
                    Source(
                        title=src_title,
                        url=showtime_url,
                        kind="web",
                        snippet=snippet or None,
                    )
                )
        elif isinstance(movies, list):
            for movie in movies[:8]:
                if not isinstance(movie, dict):
                    continue
                title = str(movie.get("title") or movie.get("name") or "").strip()
                if not title:
                    continue
                facts.append(title)
                url = str(movie.get("url") or "").strip() or None
                sources.append(Source(title=title, url=url, kind="web"))

        if not lead and not facts:
            return AdapterOutput(raw=data)

        summary: tuple[str, ...] = ()
        if lead:
            summary = (lead,)
        elif facts and location:
            summary = (f"{len(facts)} showings near {location}",)
        elif facts:
            summary = (f"{len(facts)} showings",)

        return AdapterOutput(
            summary_candidates=summary,
            facts=tuple(facts),
            sources=tuple(sources),
            raw=data,
        )
