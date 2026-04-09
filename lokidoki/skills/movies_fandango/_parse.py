"""HTML/JSON-LD extraction helpers for the Fandango skill.

Kept in a separate module so the orchestration in ``skill.py`` stays
focused on mechanism dispatch and the parser surface can be unit-tested
in isolation. None of these functions touch the network — they take a
raw HTML string and return plain dicts/lists.

Why so many extractors? Fandango's pages mix three signal sources:

  * **Anchor scrape** — every now-playing list page (ZIP, city, global,
    coming-soon, theater) embeds ``/<slug>-<id>/movie-overview`` links
    with the human title as anchor text. This is the most reliable
    signal because it lives in the initial server-rendered HTML.
  * **JSON-LD** — movie-overview pages emit a ``Movie`` schema with
    runtime/rating/synopsis; theater pages emit ``MovieTheater`` with
    address details. Per-page, never per-listing.
  * **Plain text fallback** — last-resort scrape for time patterns when
    neither structured signal is present (rarely fires today).

If Fandango's DOM changes one of these, the others keep the skill alive.
"""
from __future__ import annotations

import json
import re
from html import unescape
from typing import Iterable

TIME_PATTERN = re.compile(r"\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b", re.IGNORECASE)
ZIP_PATTERN = re.compile(r"\b(\d{5})\b")
JSONLD_BLOCK = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)
MOVIE_ANCHOR = re.compile(
    r'<a[^>]*href="/([a-z0-9-]+-\d{4,6})/movie-overview[^"]*"[^>]*>(.*?)</a>',
    re.DOTALL | re.IGNORECASE,
)
THEATER_ANCHOR = re.compile(
    r'<a[^>]*href="/([a-z0-9][a-z0-9-]+)/theater-page[^"]*"[^>]*>(.*?)</a>',
    re.DOTALL | re.IGNORECASE,
)

# Words to strip from the user's query when building a movie-title filter.
# Pure mechanical token removal — NOT classification of intent. The decomposer
# already produced a distilled query; this just normalizes "showtimes for
# Avatar" → "avatar" so a substring match against title text actually fires.
QUERY_STOP_TERMS = {
    "showtimes", "showtime", "for", "the", "movie", "movies", "of", "is",
    "still", "playing", "tonight", "today", "tomorrow", "what", "time",
    "times", "when", "where", "near", "me", "in", "details", "about",
    "info", "information", "synopsis", "rating", "runtime", "cast",
}


def extract_zip(default_zip: str) -> str:
    """Pull a 5-digit ZIP from arbitrary user input.

    Accepts ``"11201"``, ``"11201-2345"``, or ``"Brooklyn, NY 11201"``.
    Returns ``""`` if no 5-digit run is present so callers can fail
    cleanly with a useful error instead of building a malformed URL.
    """
    match = ZIP_PATTERN.search(default_zip or "")
    return match.group(1) if match else ""


def filter_terms(raw_query: str) -> list[str]:
    tokens = re.findall(r"[a-zA-Z0-9']+", (raw_query or "").lower())
    return [t for t in tokens if t and t not in QUERY_STOP_TERMS]


def matches_query(title: str, terms: list[str]) -> bool:
    if not terms:
        return True
    title_l = title.lower()
    return any(t in title_l for t in terms)


def strip_html(text: str) -> str:
    return unescape(re.sub(r"<[^>]+>", " ", text or "")).strip()


def _slugify_title(slug: str) -> str:
    """Best-effort title from a Fandango slug like ``hoppers-2026-241416``.

    Strips the trailing numeric id, title-cases the rest. Used only when
    we have a slug but no anchor text (e.g. when the only signal is a
    canonical link). Anchor text is always preferred when available.
    """
    parts = slug.split("-")
    while parts and parts[-1].isdigit():
        parts.pop()
    return " ".join(p.capitalize() for p in parts) if parts else slug


def _iter_jsonld_objects(blocks: Iterable[str]) -> Iterable[dict]:
    for block in blocks:
        try:
            parsed = json.loads(block.strip())
        except Exception:  # noqa: BLE001 — Fandango sometimes embeds invalid JSON
            continue
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    yield item
        elif isinstance(parsed, dict):
            yield parsed
            for graph in (parsed.get("@graph") or []):
                if isinstance(graph, dict):
                    yield graph


def jsonld_objects(html: str) -> list[dict]:
    return list(_iter_jsonld_objects(JSONLD_BLOCK.findall(html)))


def extract_movie_anchors(html: str) -> list[dict]:
    """Primary listing extractor: now-playing movies from overview anchors.

    Returns one entry per unique slug. Snippet is empty/"Now playing"
    because per-theater times aren't in the initial HTML.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for match in MOVIE_ANCHOR.finditer(html):
        slug = match.group(1)
        if slug in seen:
            continue
        title = strip_html(match.group(2))
        title = re.sub(r"\s+", " ", title).strip()
        if not title:
            title = _slugify_title(slug)
        seen.add(slug)
        out.append({
            "slug": slug,
            "title": title,
            "snippet": "",
            "url": f"https://www.fandango.com/{slug}/movie-overview",
        })
    return out


def extract_theater_anchors(html: str) -> list[dict]:
    """Pull theater listings (slug + name) from anchors on a chain/list page."""
    out: list[dict] = []
    seen: set[str] = set()
    for match in THEATER_ANCHOR.finditer(html):
        slug = match.group(1)
        if slug in seen:
            continue
        name = strip_html(match.group(2))
        name = re.sub(r"\s+", " ", name).strip()
        if not name:
            continue
        seen.add(slug)
        out.append({
            "slug": slug,
            "name": name,
            "url": f"https://www.fandango.com/{slug}/theater-page",
        })
    return out


def extract_movie_details(html: str) -> dict:
    """Pull a normalized movie metadata dict from a movie-overview page.

    Reads the ``Movie`` JSON-LD block when present and falls back to
    ``<h1>``/``<meta name="description">`` if Fandango drops the schema.
    Returns ``{}`` when nothing parseable is found.
    """
    for obj in _iter_jsonld_objects(JSONLD_BLOCK.findall(html)):
        if obj.get("@type") != "Movie":
            continue
        directors = obj.get("director") or []
        if isinstance(directors, dict):
            directors = [directors]
        director_names = [
            d.get("name", "") for d in directors if isinstance(d, dict)
        ]
        rating = obj.get("aggregateRating") or {}
        return {
            "title": (obj.get("name") or "").strip(),
            "runtime_minutes": obj.get("duration"),
            "content_rating": obj.get("contentRating") or "",
            "release_date": obj.get("datePublished") or "",
            "genre": obj.get("genre") or "",
            "synopsis": (obj.get("description") or "").strip(),
            "director": ", ".join(d for d in director_names if d),
            "audience_score": (
                rating.get("ratingValue") if isinstance(rating, dict) else None
            ),
            "image": obj.get("image") or "",
            "url": obj.get("url") or "",
        }
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.DOTALL | re.IGNORECASE)
    if h1:
        return {"title": strip_html(h1.group(1))}
    return {}


def extract_theater_details(html: str) -> dict:
    """Pull theater metadata from a ``MovieTheater`` JSON-LD block."""
    for obj in _iter_jsonld_objects(JSONLD_BLOCK.findall(html)):
        if obj.get("@type") != "MovieTheater":
            continue
        addr = obj.get("address") or {}
        addr_parts = []
        if isinstance(addr, dict):
            for key in ("streetAddress", "addressLocality", "addressRegion", "postalCode"):
                value = addr.get(key)
                if value:
                    addr_parts.append(value)
        return {
            "name": (obj.get("name") or "").strip(),
            "address": ", ".join(addr_parts),
            "telephone": obj.get("telephone") or "",
            "url": obj.get("url") or "",
        }
    return {}


def extract_text_fallback(html: str) -> list[dict]:
    """Plain-text scrape: find movie-title-ish lines near time patterns.

    Crude, but it salvages cases where Fandango drops both anchors and
    structured schema for a section.
    """
    text = strip_html(html)
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", text) if ln.strip()]
    out: list[dict] = []
    seen: set[str] = set()
    for line in lines:
        match = TIME_PATTERN.search(line)
        if not match:
            continue
        cut = match.start()
        title = line[:cut].strip(" -:|")
        snippet = line[cut:].strip()
        if not title or len(title) > 80 or title.lower() in seen:
            continue
        seen.add(title.lower())
        out.append({"title": title, "snippet": snippet, "url": ""})
        if len(out) >= 20:
            break
    return out


def _slug_from_mop_uri(uri: str) -> str:
    """``/raakaasaa-2026-244770/movie-overview`` → ``raakaasaa-2026-244770``."""
    if not uri:
        return ""
    parts = [p for p in uri.split("/") if p]
    return parts[0] if parts else ""


def _normalize_time(showtime: dict) -> str:
    """Pick the cleanest display string from a napi showtime entry.

    Prefers ``ticketingDate`` ("2026-04-08+20:20") because it carries
    the canonical 24-hour value and reformats cleanly to "8:20 PM".
    Falls back to ``screenReaderTime`` ("8:20 PM") and finally the
    compact ``date`` ("8:20p"). We deliberately do NOT use
    ``screenReaderTime`` first because it spells round hours as
    "12 o'clock PM" (correct for screen readers, ugly in chat output).
    """
    td = (showtime.get("ticketingDate") or "").strip()
    if td:
        # Format is "YYYY-MM-DD+HH:MM" or "YYYY-MM-DD HH:MM" — pull HH:MM
        # off the end without depending on strptime to avoid TZ surprises.
        time_part = ""
        for sep in ("+", " ", "T"):
            if sep in td:
                time_part = td.rsplit(sep, 1)[1]
                break
        if ":" in time_part:
            try:
                hh, mm = time_part.split(":", 1)
                hh_i = int(hh)
                mm = mm[:2]
                suffix = "AM" if hh_i < 12 else "PM"
                hh_12 = hh_i % 12 or 12
                return f"{hh_12}:{mm} {suffix}"
            except ValueError:
                pass
    return (
        (showtime.get("screenReaderTime") or "").strip()
        or (showtime.get("date") or "").strip()
    )


def parse_napi_theaters(payload: dict, *, drop_expired: bool = True) -> dict:
    """Normalize Fandango ``/napi/theaterswithshowtimes`` JSON.

    Walks ``theaters[].movies[].variants[].amenityGroups[].showtimes[]``
    and returns both a theater-centric view (one entry per theater with
    its movies + times) and a movie-centric view (one entry per unique
    movie with the theaters showing it). The movie-centric shape is what
    the synthesizer-facing ``showtimes`` list ultimately uses, because
    most user asks are movie-first ("what time is X playing").

    ``drop_expired=True`` filters showtimes whose ``expired`` flag is set
    by Fandango — past showtimes for today. Set False if you need the
    full grid (e.g. for a "what time was it" backwards-look query).

    Returns ``{"theaters": [...], "movies": [...]}``. Empty payload yields
    empty lists rather than raising — the mechanism layer decides whether
    that constitutes a failure.
    """
    if not isinstance(payload, dict):
        return {"theaters": [], "movies": []}
    raw_theaters = payload.get("theaters") or []
    theaters_out: list[dict] = []
    movie_index: dict[str, dict] = {}

    for t in raw_theaters:
        if not isinstance(t, dict):
            continue
        t_name = (t.get("name") or "").strip()
        t_id = str(t.get("id") or "")
        address_parts = [
            t.get("address1") or "",
            t.get("city") or "",
            t.get("state") or "",
        ]
        address = ", ".join(p for p in address_parts if p)
        slugged = t.get("sluggedName") or ""
        theater_url = f"https://www.fandango.com/{slugged}/theater-page" if slugged else ""

        theater_movies: list[dict] = []
        for m in (t.get("movies") or []):
            if not isinstance(m, dict):
                continue
            title = (m.get("title") or m.get("name") or "").strip()
            if not title:
                continue
            slug = _slug_from_mop_uri(m.get("mopURI") or "")

            # Dedupe + chronological sort. Fandango returns the same
            # slot once per format variant (Standard, Dolby, IMAX) and
            # sometimes once per amenity group, so a popular movie can
            # show the same 7:00 PM five times. Dedup against the
            # canonical 24-hour ticketingDate when present (collapses
            # variants); fall back to the display string. Sort by
            # the same canonical key so the output reads in time order.
            seen: set[str] = set()
            time_pairs: list[tuple[str, str]] = []  # (sort_key, display)
            for v in (m.get("variants") or []):
                if not isinstance(v, dict):
                    continue
                for ag in (v.get("amenityGroups") or []):
                    if not isinstance(ag, dict):
                        continue
                    for st in (ag.get("showtimes") or []):
                        if not isinstance(st, dict):
                            continue
                        if drop_expired and st.get("expired"):
                            continue
                        display = _normalize_time(st)
                        if not display:
                            continue
                        key = (st.get("ticketingDate") or "").strip() or display
                        if key in seen:
                            continue
                        seen.add(key)
                        time_pairs.append((key, display))
            time_pairs.sort(key=lambda p: p[0])
            times = [d for _, d in time_pairs]
            # Skip movies that have no surviving showtimes for this
            # theater under the current filter — keeps the synthesizer
            # from saying "Foo at AMC: " with an empty time list.
            if not times:
                continue

            theater_movies.append({
                "title": title,
                "slug": slug,
                "rating": m.get("rating") or "",
                "runtime": m.get("runtime"),
                "genres": m.get("genres") or [],
                "times": times,
            })

            key = slug or title.lower()
            entry = movie_index.setdefault(key, {
                "title": title,
                "slug": slug,
                "rating": m.get("rating") or "",
                "runtime": m.get("runtime"),
                "genres": m.get("genres") or [],
                "url": (
                    f"https://www.fandango.com/{slug}/movie-overview"
                    if slug else ""
                ),
                "theaters": [],
            })
            entry["theaters"].append({
                "name": t_name,
                "times": times,
            })

        if theater_movies:
            theaters_out.append({
                "name": t_name,
                "id": t_id,
                "address": address,
                "city": t.get("city") or "",
                "state": t.get("state") or "",
                "distance": t.get("distance"),
                "url": theater_url,
                "movies": theater_movies,
            })

    movies_out = list(movie_index.values())
    # Stable order: closest theater first, alphabetical movie within.
    movies_out.sort(key=lambda mv: mv["title"].lower())
    return {"theaters": theaters_out, "movies": movies_out}


def _theater_matches(theater_name: str, preference: str) -> bool:
    """Case-insensitive substring match between a theater and user pref.

    Users type "cinemark ct post" or "post 14"; Fandango calls it
    "Cinemark Connecticut Post 14 and IMAX". Substring match in either
    direction is intentionally generous so the user doesn't have to
    type the exact name to flag their home theater.
    """
    if not preference or not theater_name:
        return False
    p = preference.strip().lower()
    n = theater_name.strip().lower()
    return p in n or n in p


def build_napi_lead(
    parsed: dict, location_label: str, *, preferred_theater: str = ""
) -> str:
    """Build a Markdown summary grouped by **theater**, not by movie.

    Why theater-first
    -----------------
    People plan a night out by venue: "what's playing at *my* theater?"
    A movie-first listing forces the eye to scan every bullet looking
    for the home theater name buried inside the per-movie line, which
    is exactly the bug this rewrite is fixing. Theater-grouped output
    lets a user with a home theater scan a single block and decide.

    Preferred theater
    -----------------
    When ``preferred_theater`` matches one of the theaters in the
    payload (substring, case-insensitive — see ``_theater_matches``),
    that theater is rendered first with **every** movie + showtime,
    and the remaining theaters follow under an "Also nearby" header.
    When no preference is set or no theater matches, every theater is
    rendered in the order Fandango returned them (which is roughly
    distance-sorted).

    Layout (rendered as Markdown by the chat UI):

        **🎬 Cinemark Connecticut Post 14 and IMAX**
        - Hoppers — 6:30 PM, 8:00 PM, 9:45 PM
        - Project Hail Mary — 7:00 PM, 9:30 PM
        - …

        **Also nearby**
        - AMC Marquis 16
          - Hoppers — 7:15 PM
          - …
        - AMC Danbury 16
          - …

    No "+N more" truncation: every movie at every theater is listed.
    The token budget for this is small (~25 theaters × ~10 movies × ~5
    times = a few KB) and hiding data behind "more" was the second
    half of the user's complaint that drove this rewrite.
    """
    theaters = parsed.get("theaters") or []
    if not theaters:
        return ""

    pref_idx = -1
    if preferred_theater:
        for i, t in enumerate(theaters):
            if _theater_matches(t.get("name", ""), preferred_theater):
                pref_idx = i
                break

    lines: list[str] = []

    def _render_theater_block(theater: dict, *, highlighted: bool) -> list[str]:
        """One theater header + every movie under it as nested bullets."""
        name = theater.get("name") or "Unknown theater"
        header = f"**🎬 {name}**" if highlighted else f"- **{name}**"
        out = [header]
        movies = theater.get("movies") or []
        if not movies:
            return out
        indent = "  " if not highlighted else ""
        for mv in movies:
            times = ", ".join(mv.get("times") or [])
            if not times:
                continue
            title = mv.get("title") or "Untitled"
            out.append(f"{indent}- {title} — {times}")
        return out

    if pref_idx >= 0:
        # Preferred theater: highlighted block at the top, full detail.
        lines.append(f"**Tonight in {location_label}**")
        lines.append("")
        lines.extend(_render_theater_block(theaters[pref_idx], highlighted=True))
        others = [t for i, t in enumerate(theaters) if i != pref_idx]
        if others:
            lines.append("")
            lines.append("**Also nearby**")
            for t in others:
                lines.extend(_render_theater_block(t, highlighted=False))
    else:
        # No preference (or no match): theater-grouped list, no highlight.
        lines.append(f"**Now playing in {location_label}**")
        lines.append("")
        for t in theaters:
            lines.extend(_render_theater_block(t, highlighted=False))

    return "\n".join(lines)


def extract_jsonld_movies(html: str) -> list[dict]:
    """Compatibility shim: pull ``Movie``/``ScreeningEvent`` listings.

    Used as a tier-2 fallback for ``list_now_playing``. Modern ZIP pages
    only emit a ``TheaterEvent`` envelope so this rarely fires today,
    but it stays alive for movie-specific pages and for resilience if
    Fandango ever brings the schema back.
    """
    out: list[dict] = []
    for obj in _iter_jsonld_objects(JSONLD_BLOCK.findall(html)):
        type_field = obj.get("@type") or ""
        types = [type_field] if isinstance(type_field, str) else list(type_field)
        if not any(t in ("Movie", "ScreeningEvent") for t in types):
            continue
        title = (obj.get("name") or "").strip()
        if not title:
            continue
        snippet_parts = []
        if obj.get("startDate"):
            snippet_parts.append(obj["startDate"])
        loc = obj.get("location")
        if isinstance(loc, dict) and loc.get("name"):
            snippet_parts.append(loc["name"])
        out.append({
            "title": title,
            "snippet": " — ".join(snippet_parts),
            "url": obj.get("url") or "",
        })
    return out
