"""Fandango skill — multi-mechanism scraper for movies, theaters, showtimes.

Each public Fandango URL pattern that survives without JS rendering is
exposed as a separate mechanism so the orchestrator's capability router
can pick the right one for the user's intent. The mechanisms below all
share a single ``_fetch`` helper and the parsers in ``_parse.py``; this
file's job is dispatch + the per-URL ergonomics (slug resolution, date
defaults, error shaping).

Mechanism map (see ``manifest.json`` for declared metadata):

  list_now_playing      /<ZIP>_movietimes[?date=…]              local list
  global_now_playing    /movies-in-theaters                      global list
  coming_soon           /movies-coming-soon                      upcoming list
  movie_overview        /<slug>/movie-overview                   movie metadata
  movie_showtimes       /<slug>/movie-times[?date=…]             movie showtimes
  theater_page          /<slug>/theater-page                     theater details
  theater_showtimes     /<slug>/theater-page (showtime container) theater listings
  fandango_web          legacy: ZIP page + query filter          back-compat

A single shared ``_cache`` keys mechanism results by ``(method, key)``
tuple so a follow-up "what time?" turn after a "what's playing?" turn
hits in-memory instead of re-fetching Fandango. The cache is small and
per-process — fine for an interactive shell, not a server farm.

Why not headless Chrome? The per-theater showtime grid is JS-rendered
and the only way to get exact times is to intercept Fandango's internal
JSON XHRs or run a real browser. That's a deliberate non-goal here:
this skill returns "what's playing + link out", and a separate skill
(or upgrade path) can handle precise time scraping if/when needed.
"""
from __future__ import annotations

from datetime import date as _date
from typing import Any, Optional

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult
from lokidoki.skills.movies_fandango import _parse as P

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
BASE = "https://www.fandango.com"
NAPI_THEATERS_URL = f"{BASE}/napi/theaterswithshowtimes"
DEFAULT_TIMEOUT = 6.0


def _today() -> str:
    return _date.today().isoformat()


def _build_lead(query: str, results: list[dict]) -> str:
    if not results:
        return ""
    titles = [
        (r.get("title") or r.get("name") or "").strip()
        for r in results
    ]
    titles = [t for t in titles if t]
    if not titles:
        return ""
    if len(titles) == 1:
        return f"Now playing: {titles[0]}"
    # No truncation: list every title. Hiding results behind "and N
    # more" was an explicit user complaint — they want the full set.
    return f"Now playing: {', '.join(titles)}"


class FandangoShowtimesSkill(BaseSkill):
    """Multi-mechanism Fandango scraper.

    Mechanisms are dispatched through ``execute_mechanism``. Each one
    returns a ``MechanismResult`` whose ``data`` shape depends on the
    method (see individual ``_*`` implementations). All network calls
    go through ``_fetch`` so timeout/UA/error handling stay consistent.
    """

    def __init__(self) -> None:
        # Keyed by (method, normalized_key) — see _cache_key. Per-process
        # only; cleared on restart. Small enough to leave unbounded for
        # an interactive single-user shell.
        self._cache: dict[tuple[str, str], dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        dispatch = {
            "napi_theaters_with_showtimes": self._napi_theaters_with_showtimes,
            "fandango_web": self._fandango_web,
            "list_now_playing": self._list_now_playing,
            "global_now_playing": self._global_now_playing,
            "coming_soon": self._coming_soon,
            "movie_overview": self._movie_overview,
            "movie_showtimes": self._movie_showtimes,
            "theater_page": self._theater_page,
            "theater_showtimes": self._theater_showtimes,
            "local_cache": self._local_cache,
        }
        handler = dispatch.get(method)
        if not handler:
            raise ValueError(f"Unknown mechanism: {method}")
        return await handler(parameters) if method != "local_cache" else handler(parameters)

    # ---- shared helpers -------------------------------------------------

    async def _fetch_json(
        self, url: str, *, referer: str = ""
    ) -> tuple[Optional[dict], Optional[MechanismResult]]:
        """GET ``url`` and return ``(json_dict, None)`` or ``(None, error_result)``.

        Used by the ``napi_*`` mechanisms which talk to Fandango's
        internal JSON backend instead of scraping HTML. The XHR
        headers (``X-Requested-With``, ``Sec-Fetch-*``) make the
        request look like the browser-originated calls Fandango's
        own JS makes after page load — needed because the bare API
        host returns a generic 200 HTML wrapper for plain GETs.
        """
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
        }
        if referer:
            headers["Referer"] = referer
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
                response = await client.get(url, headers=headers)
        except Exception as e:  # noqa: BLE001
            return None, MechanismResult(success=False, error=f"Fandango napi fetch failed: {e}")
        if response.status_code != 200:
            return None, MechanismResult(
                success=False, error=f"Fandango napi HTTP {response.status_code}"
            )
        try:
            return response.json(), None
        except Exception as e:  # noqa: BLE001
            return None, MechanismResult(
                success=False, error=f"Fandango napi returned non-JSON: {e}"
            )

    async def _fetch(self, url: str) -> tuple[Optional[str], Optional[MechanismResult]]:
        """GET ``url`` and return ``(html, None)`` or ``(None, error_result)``.

        Centralized so every mechanism shares the same UA/timeout/error
        shape. Caller decides what to do with the HTML.
        """
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
                response = await client.get(
                    url,
                    headers={
                        "User-Agent": USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                )
        except Exception as e:  # noqa: BLE001 — surface as a clean failure
            return None, MechanismResult(success=False, error=f"Fandango fetch failed: {e}")
        if response.status_code != 200:
            return None, MechanismResult(
                success=False, error=f"Fandango HTTP {response.status_code}"
            )
        return response.text, None

    def _cache_put(self, method: str, key: str, data: dict) -> None:
        self._cache[(method, key.lower())] = data

    def _cache_get(self, method: str, key: str) -> Optional[dict]:
        return self._cache.get((method, key.lower()))

    def _resolve_zip(self, parameters: dict) -> tuple[str, Optional[MechanismResult]]:
        cfg = parameters.get("_config") or {}
        explicit = parameters.get("zip") or cfg.get("default_zip", "")
        zip_code = P.extract_zip(explicit)
        if not zip_code:
            return "", MechanismResult(
                success=False,
                error="Fandango skill needs a 5-digit US ZIP (param 'zip' or default_zip config)",
            )
        return zip_code, None

    def _build_location_url(self, parameters: dict) -> tuple[str, str, Optional[MechanismResult]]:
        """Pick the best ``/<location>_movietimes`` URL for the request.

        Prefers an explicit city/state pair when given, otherwise falls
        back to the configured ZIP. Returns ``(url, location_label, err)``.
        """
        city = (parameters.get("city") or "").strip().lower().replace(" ", "-")
        state = (parameters.get("state") or "").strip().lower()
        date_str = (parameters.get("date") or _today()).strip()
        if city and state:
            label = f"{city}_{state}"
            return f"{BASE}/{label}_movietimes?date={date_str}", label, None
        zip_code, err = self._resolve_zip(parameters)
        if err:
            return "", "", err
        return f"{BASE}/{zip_code}_movietimes?date={date_str}", zip_code, None

    # ---- mechanisms -----------------------------------------------------

    async def _napi_theaters_with_showtimes(self, parameters: dict) -> MechanismResult:
        """Real showtimes via Fandango's internal JSON backend.

        Hits ``/napi/theaterswithshowtimes`` — the same endpoint the
        Fandango website's JavaScript calls after page load. Returns
        rich, structured showtime data: per-theater movie lists, per-
        movie time grids, addresses, distances, deep ticketing links.
        This is what every other "showtimes" mechanism falls through to
        when it works, because there is no point parsing the HTML
        skeleton when the data is right here in JSON form.

        ``parameters['drop_expired']`` (default True) filters past
        showtimes for the requested date so a "what's playing tonight"
        ask doesn't get told about an 11am screening it already missed.
        """
        zip_code, err = self._resolve_zip(parameters)
        if err:
            return err
        date_str = (parameters.get("date") or _today()).strip()
        params = {
            "zipCode": zip_code,
            "city": parameters.get("city") or "",
            "state": parameters.get("state") or "",
            "date": date_str,
            "page": "1",
            "favTheaterOnly": "false",
            "limit": str(parameters.get("limit") or 25),
            "isdesktop": "true",
            "filter": "open-theaters",
            "filterEnabled": "true",
        }
        from urllib.parse import urlencode
        url = f"{NAPI_THEATERS_URL}?{urlencode(params)}"
        referer = f"{BASE}/{zip_code}_movietimes?date={date_str}"
        payload, err = await self._fetch_json(url, referer=referer)
        if err:
            return err
        drop_expired = parameters.get("drop_expired", True)
        parsed = P.parse_napi_theaters(payload, drop_expired=drop_expired)
        # Late-night recovery: if every showtime for "today" is already
        # in the past (common when the user asks at 10pm+), silently
        # roll forward to tomorrow's grid so "what's playing" still
        # answers with real, ticketable times instead of returning
        # failure and dropping us into the title-only HTML fallback.
        if (
            not parsed["movies"]
            and drop_expired
            and not parameters.get("_rolled_forward")
            and (parameters.get("date") or _today()) == _today()
        ):
            from datetime import timedelta
            tomorrow = (_date.today() + timedelta(days=1)).isoformat()
            return await self._napi_theaters_with_showtimes(
                {**parameters, "date": tomorrow, "_rolled_forward": True}
            )
        if not parsed["movies"]:
            return MechanismResult(
                success=False,
                error="Fandango napi returned no live showtimes for this location/date",
            )
        # Build a movie-centric showtimes list shaped like the legacy
        # field so existing synthesizer code keeps working unchanged,
        # but with `times` and `theaters` populated.
        showtimes = [
            {
                "title": mv["title"],
                "slug": mv["slug"],
                "url": mv["url"],
                "rating": mv["rating"],
                "runtime": mv["runtime"],
                "genres": mv["genres"],
                "theaters": mv["theaters"],
                "snippet": _napi_movie_snippet(mv),
            }
            for mv in parsed["movies"]
        ]
        cfg = parameters.get("_config") or {}
        preferred = (cfg.get("preferred_theater") or "").strip()

        # ---- per-turn theater filter -----------------------------------
        # If the caller (orchestrator clarification resolver, or the
        # decomposer in the future) injected a `theater` parameter,
        # narrow the parsed view to that one theater before building
        # the lead. Substring match in either direction matches the
        # generosity of P._theater_matches so "AMC Marquis" finds
        # "AMC Marquis 16".
        explicit_theater = (parameters.get("theater") or "").strip()
        if explicit_theater:
            picked = [
                t for t in parsed["theaters"]
                if P._theater_matches(t.get("name", ""), explicit_theater)
            ]
            if picked:
                parsed = {
                    "theaters": picked,
                    "movies": _movies_at(picked),
                }
                # Pin the chosen one as if it were the preferred theater
                # so the lead renders the highlighted block.
                preferred = explicit_theater

        # ---- ambiguity → clarification ---------------------------------
        # Trigger conditions (all must hold):
        #   * no explicit theater on the ask, AND
        #   * no preferred_theater config that actually matches one of
        #     the parsed theaters, AND
        #   * more than one theater in the result.
        # When this fires we return a SUCCESSFUL result whose `data`
        # carries a `needs_clarification` block. The orchestrator
        # detects that block, stores a PendingClarification keyed by
        # session, and emits the lead verbatim as the spoken question.
        # The user's next turn answers it.
        needs_clarif = None
        if (
            not explicit_theater
            and len(parsed["theaters"]) > 1
            and not _has_matching_preference(parsed["theaters"], preferred)
        ):
            theater_names = [t["name"] for t in parsed["theaters"] if t.get("name")]
            speakable = _speakable_clarification(zip_code, theater_names)
            needs_clarif = {
                "field": "theater",
                "options": theater_names,
                "speakable": speakable,
            }

        data = {
            "location": zip_code,
            "date": date_str,
            "theaters": parsed["theaters"],
            "showtimes": showtimes,
            "lead": (
                needs_clarif["speakable"]
                if needs_clarif
                else P.build_napi_lead(parsed, zip_code, preferred_theater=preferred)
            ),
        }
        if needs_clarif:
            data["needs_clarification"] = needs_clarif
            # The clarification picker IS short — TTS reads it as-is.
        else:
            # Showtimes lead is a wall of times; supply a brief
            # spoken alternative so the TTS layer doesn't read every
            # slot aloud.
            data["spoken_text"] = P.build_napi_spoken(parsed, preferred_theater=preferred)
        self._cache_put("napi_theaters_with_showtimes", f"{zip_code}|{date_str}", data)
        return MechanismResult(
            success=True, data=data, source_url=referer,
            source_title=f"Fandango showtimes — {zip_code} — {date_str}",
        )

    async def _fandango_web(self, parameters: dict) -> MechanismResult:
        """Legacy back-compat mechanism: ZIP page + query substring filter.

        Kept so existing call sites (and the orchestrator's capability
        upgrade from ``movies_showtimes.get_showtimes``) continue to
        work without re-routing. Internally just delegates to
        ``list_now_playing`` and applies the query filter.
        """
        raw_query = (parameters.get("query") or "").strip()
        if not raw_query:
            return MechanismResult(success=False, error="Query parameter required")

        listing = await self._list_now_playing(parameters)
        if not listing.success:
            return listing

        all_results = listing.data.get("showtimes") or []
        terms = P.filter_terms(raw_query)
        filtered = [r for r in all_results if P.matches_query(r.get("title", ""), terms)]
        results = (filtered or all_results[:5])[:5]

        data = {
            **listing.data,
            "query": raw_query,
            "search_query": f"{raw_query} ({listing.data.get('location', '')})",
            "showtimes": results,
            "lead": _build_lead(raw_query, results),
        }
        self._cache_put("fandango_web", raw_query, data)
        return MechanismResult(
            success=True,
            data=data,
            source_url=listing.source_url,
            source_title=f"Fandango showtimes — {listing.data.get('location', '')} — {raw_query}",
        )

    async def _list_now_playing(self, parameters: dict) -> MechanismResult:
        """All movies playing in a ZIP (or city/state) on a given date.

        Tier 1 is the napi JSON backend (real per-theater showtime
        grids). Tier 2 is the legacy HTML anchor scrape, kept alive so
        the skill still returns *something* if Fandango ever locks the
        napi endpoint behind auth or geo. The HTML path returns title-
        only entries (per the long-standing comments in this file)
        whereas napi returns full times — so we always prefer napi.
        """
        # Tier 1 — napi (only when we have a ZIP; city/state isn't enough)
        if parameters.get("zip") or (parameters.get("_config") or {}).get("default_zip"):
            napi = await self._napi_theaters_with_showtimes(parameters)
            if napi.success:
                return napi
        # Tier 2 — HTML scrape fallback
        url, label, err = self._build_location_url(parameters)
        if err:
            return err
        html, err = await self._fetch(url)
        if err:
            return err
        results = (
            P.extract_movie_anchors(html)
            or P.extract_jsonld_movies(html)
            or P.extract_text_fallback(html)
        )
        if not results:
            return MechanismResult(success=False, error="Fandango returned no parseable listings")
        date_str = (parameters.get("date") or _today()).strip()
        data = {
            "location": label,
            "date": date_str,
            "showtimes": results,
            "lead": _build_lead(label, results),
        }
        self._cache_put("list_now_playing", f"{label}|{date_str}", data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title=f"Fandango — now playing in {label}",
        )

    async def _global_now_playing(self, parameters: dict) -> MechanismResult:
        """Global ``/movies-in-theaters`` list — no location filter."""
        url = f"{BASE}/movies-in-theaters"
        html, err = await self._fetch(url)
        if err:
            return err
        results = P.extract_movie_anchors(html)
        if not results:
            return MechanismResult(success=False, error="Fandango global list empty")
        data = {"scope": "global", "movies": results, "lead": _build_lead("now playing", results)}
        self._cache_put("global_now_playing", "all", data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title="Fandango — movies in theaters",
        )

    async def _coming_soon(self, parameters: dict) -> MechanismResult:
        """Upcoming releases via ``/movies-coming-soon``."""
        url = f"{BASE}/movies-coming-soon"
        html, err = await self._fetch(url)
        if err:
            return err
        results = P.extract_movie_anchors(html)
        if not results:
            return MechanismResult(success=False, error="Fandango coming-soon list empty")
        data = {"scope": "coming_soon", "movies": results, "lead": _build_lead("coming soon", results)}
        self._cache_put("coming_soon", "all", data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title="Fandango — coming soon",
        )

    async def _resolve_movie_slug(self, parameters: dict) -> tuple[str, Optional[MechanismResult]]:
        """Get a movie slug from explicit param or by searching local listings.

        If ``slug`` is given we use it verbatim. Otherwise we run
        ``list_now_playing`` for the configured ZIP, filter by the
        query terms, and return the best title match. This lets the
        orchestrator pass either a clean slug or a natural-language
        query without having to know which it is.
        """
        slug = (parameters.get("slug") or "").strip()
        if slug:
            return slug, None
        query = (parameters.get("query") or "").strip()
        if not query:
            return "", MechanismResult(
                success=False,
                error="movie mechanism needs either 'slug' or 'query' parameter",
            )
        listing = await self._list_now_playing(parameters)
        if not listing.success:
            return "", listing
        terms = P.filter_terms(query)
        for entry in listing.data.get("showtimes", []):
            if P.matches_query(entry.get("title", ""), terms) and entry.get("slug"):
                return entry["slug"], None
        return "", MechanismResult(
            success=False, error=f"No Fandango movie matched '{query}' in local listings",
        )

    async def _movie_overview(self, parameters: dict) -> MechanismResult:
        """Movie metadata: title, runtime, rating, synopsis, director."""
        slug, err = await self._resolve_movie_slug(parameters)
        if err:
            return err
        url = f"{BASE}/{slug}/movie-overview"
        html, err = await self._fetch(url)
        if err:
            return err
        details = P.extract_movie_details(html)
        if not details:
            return MechanismResult(success=False, error="Fandango overview missing schema")
        details["slug"] = slug
        details["lead"] = _build_movie_lead(details)
        self._cache_put("movie_overview", slug, details)
        return MechanismResult(
            success=True, data=details, source_url=url,
            source_title=f"Fandango — {details.get('title') or slug}",
        )

    async def _movie_showtimes(self, parameters: dict) -> MechanismResult:
        """Showtimes for a specific movie at ``/<slug>/movie-times``.

        Tier 1: napi backend (real per-theater showtime grid for the
        movie, filtered to the requested ZIP). Tier 2: the legacy
        ``/<slug>/movie-times`` HTML scrape — kept as a fallback even
        though Fandango currently 302s the route to ``/movie-overview``
        and the showtime grid is JS-rendered, so it usually returns
        nothing useful. The whole point of the rewrite is that tier 1
        actually has data.
        """
        slug, err = await self._resolve_movie_slug(parameters)
        if err:
            return err
        date_str = (parameters.get("date") or _today()).strip()

        # Tier 1 — napi grid filtered to this movie's slug
        if parameters.get("zip") or (parameters.get("_config") or {}).get("default_zip"):
            napi = await self._napi_theaters_with_showtimes(parameters)
            if napi.success:
                # Find the movie in the parsed list by slug (preferred)
                # or by case-insensitive title contains.
                target_slug = slug.lower()
                query = (parameters.get("query") or "").lower().strip()
                match = None
                for mv in napi.data.get("showtimes", []):
                    if (mv.get("slug") or "").lower() == target_slug:
                        match = mv
                        break
                if not match and query:
                    for mv in napi.data.get("showtimes", []):
                        if query in (mv.get("title") or "").lower():
                            match = mv
                            break
                if match:
                    data = {
                        "slug": match.get("slug") or slug,
                        "date": date_str,
                        "movie": {
                            "title": match.get("title"),
                            "rating": match.get("rating"),
                            "runtime_minutes": match.get("runtime"),
                            "genre": ", ".join(match.get("genres") or []),
                        },
                        "theaters": match.get("theaters") or [],
                        "showtimes": [
                            {"theater": th["name"], "time": t}
                            for th in (match.get("theaters") or [])
                            for t in (th.get("times") or [])
                        ],
                        "lead": (
                            f"{match['title']}: " + _napi_movie_snippet(match)
                            if match.get("theaters")
                            else f"{match['title']}: no live showtimes"
                        ),
                    }
                    return MechanismResult(
                        success=True, data=data,
                        source_url=napi.source_url,
                        source_title=f"Fandango showtimes — {match['title']}",
                    )

        # Tier 2 — legacy HTML scrape fallback (mostly empty in practice)
        url = f"{BASE}/{slug}/movie-times?date={date_str}"
        html, err = await self._fetch(url)
        if err:
            return err
        showtimes = P.extract_jsonld_movies(html) or P.extract_text_fallback(html)
        details = P.extract_movie_details(html)
        data = {
            "slug": slug,
            "date": date_str,
            "movie": details,
            "showtimes": showtimes,
            "lead": (
                f"{details.get('title') or slug}: {len(showtimes)} listings on {date_str}"
                if showtimes
                else f"{details.get('title') or slug}: showtime grid is JS-rendered; see source link"
            ),
        }
        self._cache_put("movie_showtimes", f"{slug}|{date_str}", data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title=f"Fandango showtimes — {details.get('title') or slug}",
        )

    async def _theater_page(self, parameters: dict) -> MechanismResult:
        """Theater details: name, address, currently playing movies."""
        slug = (parameters.get("slug") or "").strip()
        if not slug:
            return MechanismResult(success=False, error="theater_page needs 'slug' parameter")
        url = f"{BASE}/{slug}/theater-page"
        html, err = await self._fetch(url)
        if err:
            return err
        details = P.extract_theater_details(html)
        movies = P.extract_movie_anchors(html)
        if not details and not movies:
            return MechanismResult(success=False, error="Fandango theater page unparseable")
        data = {
            "slug": slug,
            "theater": details,
            "movies": movies,
            "lead": (
                f"{details.get('name') or slug}: {len(movies)} movies playing"
                if movies
                else (details.get("name") or slug)
            ),
        }
        self._cache_put("theater_page", slug, data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title=f"Fandango — {details.get('name') or slug}",
        )

    async def _theater_showtimes(self, parameters: dict) -> MechanismResult:
        """Showtimes scoped to a single theater.

        Fandango's dedicated ``/<theater>/showtimes`` route is unstable
        (404s on most chains), so we hit the theater page itself and
        treat the embedded movie list as the "what's showing here"
        signal. Caller can then pivot to ``movie_showtimes`` per slug.
        """
        slug = (parameters.get("slug") or "").strip()
        if not slug:
            return MechanismResult(success=False, error="theater_showtimes needs 'slug' parameter")
        url = f"{BASE}/{slug}/theater-page"
        html, err = await self._fetch(url)
        if err:
            return err
        movies = P.extract_movie_anchors(html)
        details = P.extract_theater_details(html)
        if not movies:
            return MechanismResult(success=False, error="Fandango theater showtimes empty")
        date_str = (parameters.get("date") or _today()).strip()
        data = {
            "slug": slug,
            "date": date_str,
            "theater": details,
            "showtimes": movies,
            "lead": f"{details.get('name') or slug}: {len(movies)} movies on {date_str}",
        }
        self._cache_put("theater_showtimes", f"{slug}|{date_str}", data)
        return MechanismResult(
            success=True, data=data, source_url=url,
            source_title=f"Fandango theater showtimes — {details.get('name') or slug}",
        )

    def _local_cache(self, parameters: dict) -> MechanismResult:
        """Last-resort cache lookup keyed by raw query (legacy shape).

        Searches across all cached entries for any whose key contains
        the lowercased query string. Useful for repeat asks within the
        same session without forcing the orchestrator to know which
        mechanism populated the cache originally.
        """
        query = (parameters.get("query") or "").lower().strip()
        if not query:
            return MechanismResult(success=False, error="Cache lookup needs 'query'")
        for (method, key), data in self._cache.items():
            if query in key:
                return MechanismResult(success=True, data={**data, "_cache_method": method})
        return MechanismResult(success=False, error="Cache miss")


def _has_matching_preference(theaters: list[dict], preference: str) -> bool:
    """Does any parsed theater substring-match the user's home pref?

    The preference comes from ``cfg['preferred_theater']`` and is set
    once in settings; this check decides whether the napi mechanism
    can skip the clarification turn (because the user has already
    told us their default) or has to ask (because the preference
    doesn't match anything in this ZIP — they may be on vacation).
    """
    if not preference:
        return False
    for t in theaters:
        if P._theater_matches(t.get("name", ""), preference):
            return True
    return False


def _movies_at(theaters: list[dict]) -> list[dict]:
    """Rebuild the movie-centric view after a theater filter.

    The parsed payload carries both a theater-keyed and a movie-keyed
    view of the same data. When we narrow the theaters list (e.g. to
    the user's chosen theater), the movie-keyed view becomes stale —
    it still claims movies are playing at theaters we just removed.
    This helper rebuilds it from the surviving theater objects.
    """
    out: dict[str, dict] = {}
    for t in theaters:
        for m in t.get("movies") or []:
            key = (m.get("slug") or m.get("title") or "").lower()
            if not key:
                continue
            entry = out.setdefault(key, {
                "title": m.get("title"),
                "slug": m.get("slug", ""),
                "rating": m.get("rating", ""),
                "runtime": m.get("runtime"),
                "genres": m.get("genres") or [],
                "url": (
                    f"https://www.fandango.com/{m['slug']}/movie-overview"
                    if m.get("slug") else ""
                ),
                "theaters": [],
            })
            entry["theaters"].append({
                "name": t.get("name", ""),
                "times": m.get("times") or [],
            })
    return list(out.values())


def _speakable_clarification(location: str, theater_names: list[str]) -> str:
    """Build a numbered-list clarification question.

    The user explicitly asked for a numbered list so they can reply
    with just the number. ``resolve_choice`` already supports the
    ordinal tier ("1", "the second one", etc.), so the numbers users
    see are also the numbers they can speak. Rendered as Markdown so
    the chat UI shows a real numbered list.
    """
    if not theater_names:
        return ""
    if len(theater_names) == 1:
        return f"There's one theater near {location}: {theater_names[0]}."
    lines = [f"Which theater? Reply with a number:", ""]
    for i, name in enumerate(theater_names, start=1):
        lines.append(f"{i}. {name}")
    return "\n".join(lines)


def _napi_movie_snippet(movie: dict) -> str:
    """One-line per-movie snippet listing the first few theaters + times.

    Format: ``"AMC Milford 14: 6:00 PM, 7:30 PM · Cinemark CT Post: 8:15 PM"``.
    The synthesizer reads ``snippet`` per result for grounded output, so
    this is what ends up in the chat reply when a user asks "show me all
    the movies and showtimes". Capped at 3 theaters / 4 times each so
    the prompt stays compact.
    """
    chunks: list[str] = []
    for th in (movie.get("theaters") or [])[:3]:
        times = ", ".join((th.get("times") or [])[:4])
        if times:
            chunks.append(f"{th['name']}: {times}")
    return " · ".join(chunks)


def _build_movie_lead(details: dict) -> str:
    title = details.get("title") or "Unknown"
    bits: list[str] = []
    if details.get("content_rating"):
        bits.append(details["content_rating"])
    if details.get("runtime_minutes"):
        bits.append(f"{details['runtime_minutes']} min")
    if details.get("genre"):
        bits.append(str(details["genre"]))
    suffix = " · ".join(bits)
    return f"{title} — {suffix}" if suffix else title
