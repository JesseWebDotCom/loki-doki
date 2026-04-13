"""Free movie lookup skill — Wikipedia-backed, no API key required.

Started as an iTunes Search wrapper, but Apple's iTunes Search API
silently stopped returning movie results in 2024 — the endpoint
still 200s but ``resultCount`` is always 0 for film queries (music
still works). TMDB and OMDb both require keys, so we use Wikipedia's
free REST endpoints instead: a search call to find candidate film
articles, then a summary fetch on the top hit, with a positive
"description must mention 'film'" filter so we don't return
non-movie pages like "Avatar (Hindu deity)".
"""
import logging
import re

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

logger = logging.getLogger(__name__)

WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php"
# Wikipedia's REST API rejects requests without a User-Agent that
# identifies the caller. Anonymous httpx defaults get blanket 403s.
# Per https://meta.wikimedia.org/wiki/User-Agent_policy we name the
# project and provide a contact reference so the WMF ops team can
# reach out instead of just blackholing us if we misbehave.
WIKI_HEADERS = {
    "User-Agent": "LokiDoki/0.2 (+https://github.com/lokidoki/lokidoki-core)",
    "Accept": "application/json",
}


class WikiMoviesSkill(BaseSkill):
    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "wiki_api":
            return await self._wiki_api(parameters)
        if method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _wiki_api(self, parameters: dict) -> MechanismResult:
        raw_query = parameters.get("query")
        if not raw_query:
            return MechanismResult(success=False, error="Query parameter required")

        # The decomposer often hands us a full natural-language
        # question instead of a clean title — e.g. "how long is the
        # latest avatar movie". We reduce the phrase progressively
        # and, for each candidate, also try a "{title} (film)"
        # disambiguation form that points Wikipedia at the movie
        # article rather than a same-named topic. Text-shape repair
        # on upstream model output — not user-intent classification.
        candidates = _query_candidates(raw_query)
        # "latest"/"newest"/"recent" means: don't accept the first
        # film hit — collect every film candidate and return the one
        # with the highest release year. Otherwise Wikipedia ranks by
        # generic relevance and returns the original (e.g. Avatar
        # 2009) instead of the actual newest entry in the franchise.
        want_latest = bool(
            re.search(r"\b(latest|newest|most recent|new)\b", raw_query, re.IGNORECASE)
        )
        logger.info(
            "[movies_wiki] raw_query=%r candidates=%r want_latest=%s",
            raw_query, candidates, want_latest,
        )

        try:
            summary: dict | None = None
            best_year: int = -1
            tried: list[str] = []
            async with httpx.AsyncClient(
                timeout=4.0, follow_redirects=True, headers=WIKI_HEADERS,
            ) as client:
                # Search-first strategy. The summary endpoint is
                # exact-title only, which fails on common words like
                # "Avatar" that map to non-film articles. The search
                # API ranks by relevance and accepts " film" as a
                # filter token, so it reliably returns the movie page
                # for any reduced candidate. We then fetch the top
                # hit's summary and validate that its description
                # actually mentions "film" before accepting it.
                for cand in candidates:
                    s = await client.get(
                        WIKI_SEARCH_URL,
                        params={
                            "action": "query",
                            "list": "search",
                            "srsearch": f"{cand} film",
                            "srlimit": 5,
                            "format": "json",
                        },
                    )
                    if s.status_code != 200:
                        tried.append(f"{cand}(search {s.status_code})")
                        continue
                    hits = (
                        ((s.json() or {}).get("query") or {}).get("search") or []
                    )
                    for hit in hits:
                        title = hit.get("title", "")
                        if not title:
                            continue
                        # Skip obvious non-movie pages: lists, soundtracks,
                        # franchise overviews, etc. We require a positive
                        # film signal in the description below, so we don't
                        # need to enumerate every junk pattern here — just
                        # the cheap ones.
                        low = title.lower()
                        if any(
                            bad in low
                            for bad in ("list of", "soundtrack", "(franchise)", "filmography")
                        ):
                            continue
                        r = await client.get(
                            WIKI_SUMMARY_URL.format(
                                title=title.replace(" ", "_")
                            )
                        )
                        if r.status_code != 200:
                            tried.append(f"{title}({r.status_code})")
                            continue
                        payload = r.json() or {}
                        if payload.get("type") == "disambiguation":
                            tried.append(f"{title}(disambig)")
                            continue
                        # Positive film signal: the description or
                        # extract must mention "film". This is the
                        # reliable filter that keeps us off "Avatar
                        # (Hindu deity)" and similar.
                        desc = (payload.get("description") or "").lower()
                        extract_low = (payload.get("extract") or "").lower()
                        if "film" in desc or "film" in extract_low[:200]:
                            if want_latest:
                                # Title must contain at least one
                                # non-trivial token from the cleaned
                                # candidate. Otherwise Wikipedia's
                                # generic "film" hits (e.g. Hoppers
                                # 2026) win on year alone and we
                                # return a totally unrelated movie.
                                cand_tokens = {
                                    t for t in re.findall(r"[a-z0-9]+", cand.lower())
                                    if len(t) > 2 and t not in _STOPWORDS
                                }
                                title_low = title.lower()
                                if cand_tokens and not any(t in title_low for t in cand_tokens):
                                    tried.append(f"{title}(off-topic)")
                                    continue
                                yr = _extract_year(payload.get("extract") or "") or -1
                                if yr > best_year:
                                    best_year = yr
                                    summary = payload
                                    tried.append(f"{title}✓({yr})")
                                else:
                                    tried.append(f"{title}(older {yr})")
                                continue
                            summary = payload
                            tried.append(f"{title}✓")
                            break
                        tried.append(f"{title}(not-film)")
                    if summary and not want_latest:
                        break

            if not summary:
                logger.warning("[movies_wiki] no results. tried=%r", tried)
                return MechanismResult(
                    success=False, error=f"No movies found for {raw_query!r}",
                )

            title = _clean_title(summary.get("title", ""))
            extract = summary.get("extract", "")
            description = summary.get("description", "") or ""
            year = _extract_year(extract)
            runtime_min = _extract_runtime_min(extract)
            # The REST summary only ships the lead paragraph, which
            # often omits running time for unreleased or recent films
            # (e.g. Avatar: Fire and Ash). Fall back to the raw
            # wikitext of section 0 — that's the infobox, which has
            # a `| running time = NNN minutes` field.
            if runtime_min is None:
                raw_title = summary.get("title", "").replace(" ", "_")
                if raw_title:
                    runtime_min = await _fetch_runtime_from_infobox(raw_title)
                    if runtime_min is None:
                        runtime_min = await _scrape_runtime_from_page(raw_title)
            data = {
                "title": title,
                "release_date": f"{year}-01-01" if year else "",
                "overview": extract,
                "rating": None,
                "genre": description if "film" in description.lower() else None,
                "runtime_min": runtime_min,
                # Verbatim fast-path one-liner. The decomposer marks
                # movie lookups as response_shape="verbatim" and the
                # orchestrator returns this string directly without
                # an Ollama round-trip.
                "lead": _format_lead(title, str(year) if year else "", runtime_min, description),
            }
            self._cache[raw_query.lower()] = data
            page_url = (
                ((summary.get("content_urls") or {}).get("desktop") or {}).get("page")
                or ""
            )
            return MechanismResult(
                success=True,
                data=data,
                source_url=page_url,
                source_title=f"Wikipedia — {title}",
            )
        except Exception as e:
            logger.exception("[movies_wiki] unexpected error")
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        q = (parameters.get("query") or "").lower()
        cached = self._cache.get(q)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")


# ---- query reduction helpers --------------------------------------------


# Question prefixes the decomposer routinely leaves on the front of
# its distilled_query. Stripping these turns "how long is the latest
# avatar movie" into "the latest avatar movie", which iTunes already
# handles, and a second pass strips "the latest" / "movie" too.
_LEAD_PATTERNS = [
    r"^how long is\s+",
    r"^how long are\s+",
    r"^when did\s+",
    r"^when does\s+",
    r"^what (?:is|was) the (?:length|runtime|duration|rating|release date|genre|director|cast) of\s+",
    r"^what (?:is|was)\s+",
    r"^who (?:directed|stars in|is in)\s+",
    r"^tell me about (?:the movie\s+)?",
    r"^get (?:the )?(?:length|runtime|duration|rating|release date|genre) of (?:the )?",
    r"^get (?:the movie\s+)?",
    r"^show me (?:the movie\s+)?",
    r"^find (?:the )?(?:length|runtime|duration|rating|release date|genre) of (?:the )?",
    r"^find (?:the movie\s+)?",
    r"^search for (?:the movie\s+)?",
    r"^find movies (?:called|about|named)\s+",
    r"^(?:the )?(?:length|runtime|duration|rating|release date|genre) of (?:the )?",
    # Conversational phrasings the decomposer leaves intact when the
    # route matches lookup_movie despite the user asking a question
    # *about* a movie rather than *for* a movie.
    r"^have you (?:seen|watched|heard of)\s+(?:the (?:movie|film)\s+)?",
    r"^did you (?:see|watch|like)\s+(?:the (?:movie|film)\s+)?",
    r"^do you (?:know|like|remember)\s+(?:the (?:movie|film)\s+)?",
    r"^i (?:saw|watched|loved|liked|enjoyed|hated)\s+(?:the (?:movie|film)\s+)?",
    r"^(?:you should|you need to) (?:see|watch)\s+(?:the (?:movie|film)\s+)?",
    r"^(?:ever )?(?:seen|watched|heard of)\s+(?:the (?:movie|film)\s+)?",
]

# Filler phrases anywhere in the query that don't help search.
_FILLER_PATTERNS = [
    r"\bthe latest\b",
    r"\bthe newest\b",
    r"\bthe most recent\b",
    r"\bthe new\b",
    r"\blatest\b",
    r"\bnewest\b",
    r"\brecent\b",
    r"\bplease\b",
]

# Trailing nouns that can be safely dropped after we've stripped
# everything else (so "avatar movie" → "avatar").
_STOPWORDS = {
    "the", "latest", "newest", "recent", "new", "movie", "film", "movies",
    "films", "and", "of", "for", "with", "from", "about",
}

_TRAILING_NOUNS = [
    r"\s+movie$",
    r"\s+film$",
    r"\s+movies$",
    r"\s+films$",
]


def _query_candidates(raw: str) -> list[str]:
    """Generate progressively-reduced versions of a movie query.

    The raw decomposer output goes first — clean inputs like
    "Inception" match immediately. Each subsequent candidate is the
    previous one with one more layer of cruft removed. Duplicates
    eliminated, order preserved.
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    out: list[str] = [raw]

    # Pass 1: strip leading question/command prefixes. Loop until
    # stable so layered prefixes like "find the duration of the …"
    # are fully unwound rather than leaving "the duration of …".
    s = raw.lower()
    for _ in range(4):
        before = s
        for pat in _LEAD_PATTERNS:
            new = re.sub(pat, "", s, count=1)
            if new != s:
                s = new.strip()
                out.append(s)
                break
        if s == before:
            break

    # Pass 2: strip filler phrases anywhere.
    s2 = s
    for pat in _FILLER_PATTERNS:
        s2 = re.sub(pat, " ", s2)
    s2 = re.sub(r"\s+", " ", s2).strip()
    if s2 and s2 != s:
        out.append(s2)
        s = s2

    # Pass 3: strip trailing "movie"/"film".
    s3 = s
    for pat in _TRAILING_NOUNS:
        s3 = re.sub(pat, "", s3)
    s3 = s3.strip()
    if s3 and s3 != s:
        out.append(s3)

    # Dedup preserving order.
    seen: set[str] = set()
    result: list[str] = []
    for c in out:
        c = c.strip(" ?.!,")
        if c and c.lower() not in seen:
            seen.add(c.lower())
            result.append(c)
    return result


def _format_lead(
    title: str,
    year: str,
    runtime_min: int | None,
    genre: str | None,
) -> str:
    """One-liner answering the most common movie questions at once.

    Always names the title and year. Includes runtime when known
    (the user's "how long is" query) and genre when known.
    """
    if not title:
        return ""
    head = f"{title} ({year})" if year else title
    parts = [head]
    if runtime_min:
        hours = runtime_min // 60
        mins = runtime_min % 60
        if hours and mins:
            parts.append(f"runs {hours}h {mins}m")
        elif hours:
            parts.append(f"runs {hours}h")
        else:
            parts.append(f"runs {mins} minutes")
    if genre:
        parts.append(genre)
    return " — ".join(p for p in parts if p) + "."


def _clean_title(title: str) -> str:
    """Drop Wikipedia disambiguation suffixes like ``(film)`` or
    ``(2009 film)`` so the lead reads naturally.
    """
    return re.sub(r"\s*\((?:\d{4}\s+)?film\)\s*$", "", title or "").strip()


# Wikipedia film summaries reliably open with "{Title} is a {YYYY}
# {genre} film..." so we yank the first 4-digit year. Years before
# 1900 are dropped to avoid catching dates from in-article history.
_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")


def _extract_year(text: str) -> int | None:
    if not text:
        return None
    m = _YEAR_RE.search(text)
    return int(m.group(1)) if m else None


# Same idea for runtime — film infobox prose includes phrases like
# "with a running time of 162 minutes" or "162-minute". Both are
# captured by the same loose pattern.
_RUNTIME_RE = re.compile(r"(\d{2,3})\s*[-\s]*minute", re.IGNORECASE)


async def _fetch_runtime_from_infobox(raw_title: str) -> int | None:
    """Pull running time from the article infobox via parse API.

    The REST summary endpoint only returns the lead paragraph, which
    omits running time for unreleased or recent films. The MediaWiki
    parse API exposes raw wikitext for section 0 (the infobox), which
    has a stable ``| running time = NNN minutes`` field.
    """
    try:
        async with httpx.AsyncClient(
            timeout=4.0, follow_redirects=True, headers=WIKI_HEADERS,
        ) as client:
            r = await client.get(
                WIKI_SEARCH_URL,
                params={
                    "action": "parse",
                    "page": raw_title,
                    "prop": "wikitext",
                    "section": 0,
                    "format": "json",
                },
            )
            if r.status_code != 200:
                return None
            wikitext = (
                ((r.json() or {}).get("parse") or {}).get("wikitext") or {}
            ).get("*", "")
            if not wikitext:
                return None
            # Wikipedia film infoboxes use both "running time" and the
            # shorter "runtime" — Avatar: Fire and Ash uses the latter.
            m = re.search(
                r"\|\s*(?:running\s*time|runtime)\s*=\s*[^0-9]*(\d{2,3})",
                wikitext,
                re.IGNORECASE,
            )
            if not m:
                return None
            val = int(m.group(1))
            return val if 30 <= val <= 360 else None
    except Exception:
        logger.exception("[movies_wiki] infobox fetch failed for %r", raw_title)
        return None


async def _scrape_runtime_from_page(raw_title: str) -> int | None:
    """Last-resort: scrape the rendered article HTML for the infobox.

    The wikitext infobox fetch covers the common case, but some film
    articles use templated infoboxes (``{{Infobox film}}``) where the
    running time field is computed at render time and not present as
    a literal ``| running time = NNN minutes`` line in section 0.
    The rendered HTML always exposes a ``<th>Running time</th>`` row
    in the right-column infobox, so we fall back to that.
    """
    try:
        url = f"https://en.wikipedia.org/wiki/{raw_title}"
        async with httpx.AsyncClient(
            timeout=4.0, follow_redirects=True, headers=WIKI_HEADERS,
        ) as client:
            r = await client.get(url)
            if r.status_code != 200:
                return None
            html = r.text
            # Find the infobox row whose header is "Running time" and
            # pull the first 2-3 digit minutes value out of the cell
            # that follows. Wikipedia's HTML uses <th>Running time</th>
            # then a sibling <td> with the value.
            m = re.search(
                r"Running time</th>.*?<td[^>]*>(.*?)</td>",
                html,
                re.IGNORECASE | re.DOTALL,
            )
            if not m:
                return None
            cell = re.sub(r"<[^>]+>", " ", m.group(1))
            mm = re.search(r"(\d{2,3})\s*minutes?", cell, re.IGNORECASE)
            if not mm:
                return None
            val = int(mm.group(1))
            return val if 30 <= val <= 360 else None
    except Exception:
        logger.exception("[movies_wiki] page scrape failed for %r", raw_title)
        return None


def _extract_runtime_min(text: str) -> int | None:
    if not text:
        return None
    m = _RUNTIME_RE.search(text)
    if not m:
        return None
    val = int(m.group(1))
    # Sanity bounds — anything outside [30, 360] is probably noise.
    return val if 30 <= val <= 360 else None
