"""Search the per-region FTS5 indices built by :mod:`.fts_index`.

One call to :func:`search` runs the query against every installed
region whose bbox the caller included in the ``regions`` argument and
merges the results via :func:`lokidoki.maps.geocode.merge_results`.
Ranking is BM25 plus a viewport-proximity penalty — close matches
float above distant ones of the same relevance.

Kept intentionally narrow so the admin / route layer can pass an
explicit region list (already filtered by viewport coverage) and we
never accidentally load uninstalled regions from disk.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from math import cos, radians
from pathlib import Path

from . import GeocodeResult, haversine_km, merge_results
from .fts_index import region_db_path

log = logging.getLogger(__name__)

_PROXIMITY_WEIGHT = 0.02    # score -= weight * distance_km
_PROXIMITY_CAP = 3.0        # max distance penalty magnitude
_PER_REGION_LIMIT = 25      # raw rows pulled per region before merge
_MIN_TOKEN_LEN = 2          # avoid 1-char FTS tokens ("a*") exploding
_DEDUP_RADIUS_KM = 0.025
# Reserved FTS5 punctuation that would break MATCH — drop from user
# tokens before concatenating.
_FTS_STRIP = set('"()*:')
_US_STATE_ABBREV = frozenset({
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
    "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
    "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
    "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
    "wi", "wy", "dc",
})
_ADDRESS_STOPWORDS = frozenset({"in", "at", "on", "near", "by", "of", "the"})


def _is_openaddresses_result(result: GeocodeResult) -> bool:
    return ":oa:" in result.place_id


def _address_key(result: GeocodeResult) -> tuple[str, str] | None:
    parts = result.title.lower().split()
    if len(parts) < 2 or not any(ch.isdigit() for ch in parts[0]):
        return None
    return (parts[0], " ".join(parts[1:]).strip())


def _prefer_result(candidate: GeocodeResult, incumbent: GeocodeResult) -> bool:
    if candidate.score != incumbent.score:
        return candidate.score > incumbent.score
    if _is_openaddresses_result(candidate) != _is_openaddresses_result(incumbent):
        return _is_openaddresses_result(candidate)
    return False


def _dedup_results(results: list[GeocodeResult]) -> list[GeocodeResult]:
    best: dict[tuple[str, str], list[GeocodeResult]] = {}
    passthrough: list[GeocodeResult] = []
    for row in sorted(results, key=lambda r: r.score, reverse=True):
        key = _address_key(row)
        if key is None:
            passthrough.append(row)
            continue
        group = best.setdefault(key, [])
        for idx, existing in enumerate(group):
            distance = haversine_km((row.lat, row.lon), (existing.lat, existing.lon))
            if distance > _DEDUP_RADIUS_KM:
                continue
            if _prefer_result(row, existing):
                group[idx] = row
            break
        else:
            group.append(row)
    deduped = passthrough + [item for group in best.values() for item in group]
    return sorted(deduped, key=lambda r: r.score, reverse=True)


def _tokenise(query: str) -> list[str]:
    """Split user text into FTS5-safe tokens."""
    out: list[str] = []
    for raw in query.replace(",", " ").split():
        cleaned = "".join(c for c in raw if c not in _FTS_STRIP)
        cleaned = cleaned.strip()
        low = cleaned.lower()
        if low in _US_STATE_ABBREV or low in _ADDRESS_STOPWORDS:
            continue
        if len(cleaned) >= _MIN_TOKEN_LEN:
            out.append(cleaned)
    return out


def _build_match(query: str) -> str | None:
    """Build an FTS5 MATCH expression.

    Trailing token gets a ``*`` for live-typing autocomplete
    (``150 stil*``). Earlier tokens are matched verbatim.
    """
    tokens = _tokenise(query)
    if not tokens:
        return None
    parts = [f'"{t}"' for t in tokens[:-1]]
    parts.append(f'"{tokens[-1]}"*')
    return " ".join(parts)


def _format_subtitle(
    city: str,
    admin1: str,
    postcode: str,
    region_id: str,
) -> str:
    """Build the muted subtitle line from the row's address bits.

    Returns the empty string — not the raw region id — when every
    locality field is missing. Surfacing machine region codes like
    ``us-ct`` in a user-visible subtitle leaks an internal id into the
    hover / details card instead of a readable address.
    """
    del region_id  # kept for call-site compatibility; no longer a fallback
    parts = [p for p in (city, admin1, postcode) if p]
    if parts:
        return ", ".join(parts)
    return ""


def _row_to_result(row: tuple, region_id: str, viewport: tuple[float, float] | None) -> GeocodeResult:
    (
        osm_id, name, housenumber, street, city,
        postcode, admin1, lat, lon, klass, bm25,
    ) = row

    street_line = f"{housenumber} {street}".strip()
    title = name.strip() or street_line
    locality = _format_subtitle(city, admin1, postcode, region_id)
    # For a named POI whose OSM tags carry an addr:housenumber+addr:street
    # pair, surface the street address in the subtitle so hover cards and
    # search rows show "500 Nyala Farms Road, Westport, CT, 06880" instead
    # of just the locality. The title == street_line case (plain address
    # row with no name) is already handled by `locality` alone.
    if name.strip() and street_line and street_line != title:
        subtitle = f"{street_line}, {locality}" if locality else street_line
    else:
        subtitle = locality

    # BM25 in FTS5 is "lower is better"; invert so higher == better.
    # Typical BM25 values for short queries are 2-15. Invert + offset so
    # the score stays in a comfortable positive range.
    score = -float(bm25)

    if viewport is not None:
        distance_km = haversine_km(viewport, (float(lat), float(lon)))
        penalty = min(_PROXIMITY_CAP, _PROXIMITY_WEIGHT * distance_km)
        score -= penalty

    return GeocodeResult(
        place_id=f"{region_id}:osm:{osm_id}",
        title=title,
        subtitle=subtitle,
        lat=float(lat),
        lon=float(lon),
        bbox=None,
        source="fts",
        score=score,
        category=str(klass) if klass else None,
    )


def _bbox_for_radius(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Approximate a lat/lon bbox that encloses ``radius_km`` around a point."""
    lat_delta = radius_km / 110.574
    lon_scale = max(0.1, abs(cos(radians(lat))))
    lon_delta = radius_km / (111.320 * lon_scale)
    return (lat - lat_delta, lat + lat_delta, lon - lon_delta, lon + lon_delta)


def _nearest_rank(klass: str, distance_km: float) -> tuple[int, float]:
    """Rank reverse-geocode candidates by usefulness, then distance.

    Named POIs outrank plain addresses so a hover over a shop-row
    building surfaces ``Barosa Indian Kitchen`` (with its category) rather
    than the bare ``157 Cherry St`` address. POI rows already carry
    ``addr:*`` fields when present, so no address information is lost.
    """
    if klass.startswith("poi:"):
        return (3, -distance_km)
    if klass == "address":
        return (2, -distance_km)
    if klass == "postcode":
        return (1, -distance_km)
    return (0, -distance_km)


def _search_region_sync(
    db_path: Path,
    region_id: str,
    match_expr: str,
    viewport: tuple[float, float] | None,
) -> list[GeocodeResult]:
    if not db_path.exists():
        return []
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA query_only = 1")
    try:
        cur = conn.execute(
            """
            SELECT osm_id, name, housenumber, street, city,
                   postcode, admin1, lat, lon, class, bm25(places)
              FROM places
             WHERE places MATCH ?
             ORDER BY bm25(places)
             LIMIT ?
            """,
            (match_expr, _PER_REGION_LIMIT),
        )
        return [_row_to_result(r, region_id, viewport) for r in cur.fetchall()]
    except sqlite3.OperationalError as exc:
        log.warning("FTS query failed for %s: %s", region_id, exc)
        return []
    finally:
        conn.close()


def _rtree_row_count(conn: sqlite3.Connection) -> int | None:
    """Row count of ``places_rtree``, or None if the table does not exist."""
    try:
        row = conn.execute("SELECT COUNT(*) FROM places_rtree").fetchone()
    except sqlite3.OperationalError:
        return None
    return int(row[0]) if row else 0


# Per-path memo: True = rtree populated and safe for fast path;
# False = definitely not usable (backfill failed or DB too old).
_RTREE_READY: dict[Path, bool] = {}


def _ensure_rtree(db_path: Path) -> bool:
    """Return True iff the rtree for ``db_path`` is populated and matches
    the FTS row count. Lazily creates + populates on the first call
    against a pre-rtree index. Failures fall through — callers should
    use the slow bbox scan instead of serving empty results."""
    cached = _RTREE_READY.get(db_path)
    if cached is not None:
        return cached
    ready = False
    try:
        conn = sqlite3.connect(str(db_path))
    except sqlite3.Error:
        _RTREE_READY[db_path] = False
        return False
    try:
        rtree_count = _rtree_row_count(conn)
        places_count = conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        if rtree_count is None:
            conn.execute(
                "CREATE VIRTUAL TABLE places_rtree USING rtree("
                "id, min_lat, max_lat, min_lon, max_lon)"
            )
            rtree_count = 0
        if rtree_count < places_count:
            conn.execute(
                """
                INSERT INTO places_rtree(id, min_lat, max_lat, min_lon, max_lon)
                SELECT rowid, lat, lat, lon, lon FROM places
                 WHERE rowid NOT IN (SELECT id FROM places_rtree)
                """,
            )
            conn.commit()
            rtree_count = _rtree_row_count(conn) or 0
        ready = rtree_count >= places_count and places_count > 0
    except sqlite3.OperationalError as exc:
        log.warning("R-Tree backfill failed for %s: %s", db_path, exc)
        ready = False
    finally:
        conn.close()
    _RTREE_READY[db_path] = ready
    return ready


def _nearest_region_sync(
    db_path: Path,
    region_id: str,
    lat: float,
    lon: float,
    max_radius_km: float,
) -> GeocodeResult | None:
    if not db_path.exists():
        return None
    rtree_ready = _ensure_rtree(db_path)
    min_lat, max_lat, min_lon, max_lon = _bbox_for_radius(lat, lon, max_radius_km)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA query_only = 1")
    try:
        # R-Tree companion turns an O(n) bbox scan into an O(log n)
        # spatial lookup. Older indexes (built before the rtree
        # schema landed) fall back to the linear scan.
        #
        # NB: SQLite's planner picks the wrong leading table when the
        # rtree is JOINed against an FTS5 virtual table — it scans the
        # million-row `places` index first and probes the rtree per row
        # (~600 ms on us-ct). Wrapping the rtree in an IN subquery
        # pins it as the constraint source so `places` is looked up by
        # rowid. Drops the query from ~600 ms to <1 ms on us-ct.
        if rtree_ready:
            cur = conn.execute(
                """
                SELECT osm_id, name, housenumber, street, city,
                       postcode, admin1, lat, lon, class, 0.0
                  FROM places
                 WHERE rowid IN (
                   SELECT id FROM places_rtree
                    WHERE min_lat <= ? AND max_lat >= ?
                      AND min_lon <= ? AND max_lon >= ?
                 )
                """,
                (max_lat, min_lat, max_lon, min_lon),
            )
        else:
            cur = conn.execute(
                """
                SELECT osm_id, name, housenumber, street, city,
                       postcode, admin1, lat, lon, class, 0.0
                  FROM places
                 WHERE lat BETWEEN ? AND ?
                   AND lon BETWEEN ? AND ?
                """,
                (min_lat, max_lat, min_lon, max_lon),
            )
        nearest: GeocodeResult | None = None
        nearest_rank: tuple[int, float] | None = None
        for row in cur.fetchall():
            klass = str(row[9] or "")
            candidate = _row_to_result(row, region_id, viewport=None)
            distance = haversine_km((lat, lon), (candidate.lat, candidate.lon))
            if distance > max_radius_km:
                continue
            candidate_rank = _nearest_rank(klass, distance)
            if nearest_rank is not None and candidate_rank <= nearest_rank:
                continue
            nearest = GeocodeResult(
                place_id=candidate.place_id,
                title=candidate.title,
                subtitle=candidate.subtitle,
                lat=candidate.lat,
                lon=candidate.lon,
                bbox=candidate.bbox,
                source=candidate.source,
                score=-distance,
                category=candidate.category,
            )
            nearest_rank = candidate_rank
        return nearest
    except sqlite3.OperationalError as exc:
        log.warning("Nearest FTS query failed for %s: %s", region_id, exc)
        return None
    finally:
        conn.close()


async def search(
    query: str,
    viewport: tuple[float, float] | None,
    regions: list[str],
    data_root: Path | None = None,
    limit: int = 10,
) -> list[GeocodeResult]:
    """Geocode ``query`` against every region in ``regions``.

    ``viewport`` is a ``(lat, lon)`` pair — used to bias ranking toward
    nearby hits. ``data_root`` defaults to ``data/`` (the process CWD's
    data dir); tests pass a ``tmp_path``.
    """
    match_expr = _build_match(query)
    if match_expr is None or not regions:
        return []

    root = data_root or Path("data")

    # SQLite connections are not thread-safe across loops, so each
    # region query runs in the default executor. Region count is small
    # (≤ a handful installed) so we do not bother with a pool.
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(
            None,
            _search_region_sync,
            region_db_path(root, region_id),
            region_id,
            match_expr,
            viewport,
        )
        for region_id in regions
    ]
    groups = await asyncio.gather(*tasks)
    merged = merge_results(list(groups), limit=max(limit, _PER_REGION_LIMIT * len(regions)))
    return _dedup_results(merged)[:limit]


async def nearest(
    lat: float,
    lon: float,
    regions: list[str],
    data_root: Path | None = None,
    max_radius_km: float = 0.05,
) -> GeocodeResult | None:
    """Return the nearest indexed place within ``max_radius_km``."""
    if not regions:
        return None
    root = data_root or Path("data")
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(
            None,
            _nearest_region_sync,
            region_db_path(root, region_id),
            region_id,
            lat,
            lon,
            max_radius_km,
        )
        for region_id in regions
    ]
    hits = [hit for hit in await asyncio.gather(*tasks) if hit is not None]
    if not hits:
        return None
    return max(hits, key=lambda item: item.score)


__all__ = ["search", "nearest", "_dedup_results", "_tokenise"]
