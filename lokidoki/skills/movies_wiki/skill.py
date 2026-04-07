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
        logger.info(
            "[movies_wiki] raw_query=%r candidates=%r", raw_query, candidates,
        )

        try:
            summary: dict | None = None
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
                            summary = payload
                            tried.append(f"{title}✓")
                            break
                        tried.append(f"{title}(not-film)")
                    if summary:
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
    r"^what (?:is|was) the (?:length|runtime|rating|release date|genre|director|cast) of\s+",
    r"^what (?:is|was)\s+",
    r"^who (?:directed|stars in|is in)\s+",
    r"^tell me about (?:the movie\s+)?",
    r"^get (?:the )?(?:length|runtime|rating|release date|genre) of (?:the )?",
    r"^get (?:the movie\s+)?",
    r"^show me (?:the movie\s+)?",
    r"^find (?:the movie\s+)?",
    r"^search for (?:the movie\s+)?",
    r"^find movies (?:called|about|named)\s+",
]

# Filler phrases anywhere in the query that don't help search.
_FILLER_PATTERNS = [
    r"\bthe latest\b",
    r"\bthe newest\b",
    r"\bthe most recent\b",
    r"\bthe new\b",
    r"\brecent\b",
    r"\bplease\b",
]

# Trailing nouns that can be safely dropped after we've stripped
# everything else (so "avatar movie" → "avatar").
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

    # Pass 1: strip leading question/command prefixes.
    s = raw.lower()
    for pat in _LEAD_PATTERNS:
        new = re.sub(pat, "", s, count=1)
        if new != s:
            s = new
            out.append(s.strip())
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


def _extract_runtime_min(text: str) -> int | None:
    if not text:
        return None
    m = _RUNTIME_RE.search(text)
    if not m:
        return None
    val = int(m.group(1))
    # Sanity bounds — anything outside [30, 360] is probably noise.
    return val if 30 <= val <= 360 else None
