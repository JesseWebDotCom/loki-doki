"""Build the per-region FTS5 address index from a Geofabrik ``.osm.pbf``.

One index per region — written to ``data/maps/<region_id>/geocoder.sqlite``
by :mod:`lokidoki.maps.store` right after the PBF download lands. The
SQL schema is the FTS5 virtual table defined in
``docs/roadmap/offline-maps/chunk-5-offline-geocoding.md``.

Three row flavours feed the index:

* **Addresses** — any node or way carrying ``addr:housenumber`` and
  ``addr:street``. The row's coordinates are the node location, or the
  way's first node location.
* **Settlements** — any node with ``place=city|town|village|hamlet|suburb|neighbourhood``.
* **Postcodes** — any node or way carrying ``addr:postcode`` gets a
  compact row keyed by ZIP prefix, so typing a ZIP alone finds
  something.

The single-pass streamer keeps peak RAM bounded (pyosmium's
``with_locations`` holds a node-id → lat/lon dict for the whole file;
at state scale that is tens of MB). Each batch of rows is written
inside one SQL transaction so FTS5 indexing happens once per batch
instead of once per row.
"""
from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

log = logging.getLogger(__name__)


# Settlements the geocoder should surface — ordered by rough population
# so more-important places tie-break on top when BM25 scores match.
_SETTLEMENT_PLACES = {
    "city": 5,
    "town": 4,
    "village": 3,
    "hamlet": 2,
    "suburb": 2,
    "neighbourhood": 1,
}

_BATCH_SIZE = 1000

_CREATE_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS places USING fts5(
    region UNINDEXED,
    osm_id UNINDEXED,
    name,
    housenumber,
    street,
    city,
    postcode,
    admin1,
    lat UNINDEXED,
    lon UNINDEXED,
    class UNINDEXED,
    tokenize = "unicode61 remove_diacritics 2"
);
"""


@dataclass
class IndexStats:
    """Row counts broken down by kind — surfaced in install UX."""

    addresses: int = 0
    settlements: int = 0
    postcodes: int = 0

    @property
    def total(self) -> int:
        return self.addresses + self.settlements + self.postcodes


@dataclass(frozen=True)
class _Row:
    osm_id: str
    name: str
    housenumber: str
    street: str
    city: str
    postcode: str
    admin1: str
    lat: float
    lon: float
    klass: str


def _open_db(output_db: Path) -> sqlite3.Connection:
    output_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(output_db))
    # Large FTS batch inserts benefit from less durable sync — the index
    # is fully rebuildable from the PBF so WAL + NORMAL sync is fine.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.executescript(_CREATE_SCHEMA)
    return conn


def _flush(conn: sqlite3.Connection, region_id: str, batch: list[_Row]) -> None:
    if not batch:
        return
    conn.executemany(
        """
        INSERT INTO places (
            region, osm_id, name, housenumber, street,
            city, postcode, admin1, lat, lon, class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                region_id,
                r.osm_id,
                r.name,
                r.housenumber,
                r.street,
                r.city,
                r.postcode,
                r.admin1,
                r.lat,
                r.lon,
                r.klass,
            )
            for r in batch
        ],
    )
    conn.commit()
    batch.clear()


def _address_row(
    osm_id: str,
    tags: dict[str, str],
    lat: float,
    lon: float,
) -> _Row | None:
    house = (tags.get("addr:housenumber") or "").strip()
    street = (tags.get("addr:street") or "").strip()
    if not house or not street:
        return None
    city = (
        tags.get("addr:city")
        or tags.get("addr:town")
        or tags.get("addr:village")
        or tags.get("addr:suburb")
        or ""
    ).strip()
    postcode = (tags.get("addr:postcode") or "").strip()
    admin1 = (tags.get("addr:state") or tags.get("addr:province") or "").strip()
    name = (tags.get("name") or f"{house} {street}").strip()
    return _Row(
        osm_id=osm_id,
        name=name,
        housenumber=house,
        street=street,
        city=city,
        postcode=postcode,
        admin1=admin1,
        lat=lat,
        lon=lon,
        klass="address",
    )


def _settlement_row(
    osm_id: str,
    tags: dict[str, str],
    lat: float,
    lon: float,
) -> _Row | None:
    place = (tags.get("place") or "").strip().lower()
    if place not in _SETTLEMENT_PLACES:
        return None
    name = (tags.get("name") or "").strip()
    if not name:
        return None
    admin1 = (
        tags.get("is_in:state")
        or tags.get("is_in:province")
        or tags.get("addr:state")
        or ""
    ).strip()
    postcode = (tags.get("postal_code") or tags.get("addr:postcode") or "").strip()
    return _Row(
        osm_id=osm_id,
        name=name,
        housenumber="",
        street="",
        city=name,
        postcode=postcode,
        admin1=admin1,
        lat=lat,
        lon=lon,
        klass=f"place:{place}",
    )


def _postcode_row(
    osm_id: str,
    tags: dict[str, str],
    lat: float,
    lon: float,
) -> _Row | None:
    zip_code = (tags.get("addr:postcode") or tags.get("postal_code") or "").strip()
    if not zip_code:
        return None
    # Skip when this is already emitted as an address or settlement —
    # callers check address/settlement first so we only hit this path
    # for "pure" postcode features (boundary=postal_code ways).
    if tags.get("boundary") != "postal_code":
        return None
    city = (tags.get("name") or zip_code).strip()
    admin1 = (tags.get("addr:state") or "").strip()
    return _Row(
        osm_id=osm_id,
        name=zip_code,
        housenumber="",
        street="",
        city=city,
        postcode=zip_code,
        admin1=admin1,
        lat=lat,
        lon=lon,
        klass="postcode",
    )


def _way_centroid(way) -> tuple[float, float] | None:
    """Return the first valid node location for a way.

    A true centroid would be better but doubles per-way cost for little
    geocoder win (users search for addresses, not building polygons).
    The first node is within the building's footprint by definition.
    """
    for node in way.nodes:
        loc = node.location
        if loc.valid():
            return (loc.lat, loc.lon)
    return None


def build_index(
    pbf_path: Path,
    output_db: Path,
    region_id: str,
    progress_cb: Callable[[int, str], None] | None = None,
) -> IndexStats:
    """Stream ``pbf_path`` into an FTS5 index at ``output_db``.

    ``region_id`` is stored UNINDEXED on every row so
    :func:`lokidoki.maps.geocode.fts_search.search` can filter by
    installed regions. ``progress_cb(rows_written, phase)`` is called
    opportunistically for SSE surfacing — safe to ignore.
    """
    import osmium  # lazy — keeps test imports cheap and platform-safe.

    if not pbf_path.exists():
        raise FileNotFoundError(f"pbf not found: {pbf_path}")

    conn = _open_db(output_db)
    stats = IndexStats()
    batch: list[_Row] = []

    if progress_cb:
        progress_cb(0, "indexing")

    try:
        processor = osmium.FileProcessor(str(pbf_path)).with_locations()
        for obj in processor:
            osm_id = f"{obj.__class__.__name__[0].lower()}{obj.id}"
            tags = {t.k: t.v for t in obj.tags}
            if not tags:
                continue

            # Resolve coordinates for each entity type.
            coords: tuple[float, float] | None = None
            if obj.__class__.__name__ == "Node":
                loc = obj.location
                if loc.valid():
                    coords = (loc.lat, loc.lon)
            elif obj.__class__.__name__ == "Way":
                coords = _way_centroid(obj)
            else:
                continue  # skip relations for now — Chunk 5 spec

            if coords is None:
                continue
            lat, lon = coords

            row = _address_row(osm_id, tags, lat, lon)
            if row is not None:
                batch.append(row)
                stats.addresses += 1
            else:
                row = _settlement_row(osm_id, tags, lat, lon)
                if row is not None:
                    batch.append(row)
                    stats.settlements += 1
                else:
                    row = _postcode_row(osm_id, tags, lat, lon)
                    if row is not None:
                        batch.append(row)
                        stats.postcodes += 1

            if len(batch) >= _BATCH_SIZE:
                _flush(conn, region_id, batch)
                if progress_cb:
                    progress_cb(stats.total, "indexing")

        _flush(conn, region_id, batch)
        if progress_cb:
            progress_cb(stats.total, "ready")

        log.info(
            "FTS index built for %s: %d addresses, %d settlements, %d postcodes",
            region_id, stats.addresses, stats.settlements, stats.postcodes,
        )
        return stats

    finally:
        conn.close()


def region_db_path(data_root: Path, region_id: str) -> Path:
    """Canonical on-disk location for a region's geocoder index."""
    return data_root / "maps" / region_id / "geocoder.sqlite"


def row_counts(db_path: Path) -> IndexStats:
    """Return the built-index's row counts per kind.

    Used by tests and by Settings → Maps to show *"42 MB · 1.2 M rows"*.
    """
    stats = IndexStats()
    if not db_path.exists():
        return stats
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.execute(
            "SELECT class, COUNT(*) FROM places GROUP BY class"
        )
        for klass, count in cur.fetchall():
            if klass == "address":
                stats.addresses = count
            elif klass == "postcode":
                stats.postcodes = count
            elif isinstance(klass, str) and klass.startswith("place:"):
                stats.settlements += count
        return stats
    finally:
        conn.close()


__all__ = [
    "IndexStats",
    "build_index",
    "region_db_path",
    "row_counts",
]


# Small re-export so tests can spin through the streamer without
# having to know the pyosmium-specific signature.
def _iter_entities(pbf_path: Path) -> Iterable:
    import osmium
    yield from osmium.FileProcessor(str(pbf_path)).with_locations()
