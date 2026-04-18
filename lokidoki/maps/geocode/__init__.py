"""Offline geocoding for the maps subsystem.

Each installed region contributes a ``geocoder.sqlite`` FTS5 index built
from its Geofabrik ``.osm.pbf`` extract. ``fts_search.search`` unions
results across every region whose bbox covers the viewport, ranks with
BM25 plus a viewport-proximity bonus, and returns :class:`GeocodeResult`
rows. When no installed region covers the viewport, callers fall back
to :mod:`.nominatim_fallback`.

The backend interface is deliberately narrow (``GeocoderProtocol``) so
a future Photon / Pelias shim can drop in without touching the API
surface — see ``docs/roadmap/offline-maps/chunk-5-offline-geocoding.md``
for the deferral.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from typing import Protocol


@dataclass(frozen=True)
class GeocodeResult:
    """A single normalised geocoder hit.

    Shape is contract-stable — the ``/geocode`` route, FTS backend, and
    Nominatim fallback all converge on this dataclass before anything
    reaches the frontend.
    """

    place_id: str
    title: str
    subtitle: str
    lat: float
    lon: float
    bbox: tuple[float, float, float, float] | None
    source: str  # "fts" | "nominatim"
    score: float  # higher = better. BM25 − distance penalty.


class GeocoderProtocol(Protocol):
    """Any geocoder we support implements this shape."""

    async def search(
        self,
        query: str,
        viewport: tuple[float, float] | None,
        regions: list[str],
    ) -> list[GeocodeResult]:
        ...


# ── Utilities ─────────────────────────────────────────────────────

def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in kilometres between two (lat, lon) points."""
    lat1, lon1 = a
    lat2, lon2 = b
    r_lat1, r_lat2 = radians(lat1), radians(lat2)
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    h = sin(d_lat / 2) ** 2 + cos(r_lat1) * cos(r_lat2) * sin(d_lon / 2) ** 2
    return 2 * 6371.0088 * asin(sqrt(h))


def _dedup_key(r: GeocodeResult) -> tuple[str, str]:
    """Key used to detect near-duplicates across regions.

    Two rows at the same rounded coordinate with the same title collapse
    into one — this catches a border address that fell into both a
    state and a country extract.
    """
    # ~50 m precision at mid-latitudes (~0.0005 deg).
    lat_key = f"{round(r.lat, 4):.4f}"
    lon_key = f"{round(r.lon, 4):.4f}"
    return (r.title.lower().strip(), f"{lat_key},{lon_key}")


def merge_results(
    groups: list[list[GeocodeResult]],
    limit: int = 10,
) -> list[GeocodeResult]:
    """Flatten per-region result lists, dedupe, and rank by score desc.

    Callers run one FTS query per installed region, then pass each
    region's hit list as an element of ``groups``. Duplicate rows (same
    title within ~50 m) are collapsed — higher score wins.
    """
    best: dict[tuple[str, str], GeocodeResult] = {}
    for group in groups:
        for row in group:
            key = _dedup_key(row)
            incumbent = best.get(key)
            if incumbent is None or row.score > incumbent.score:
                best[key] = row
    ranked = sorted(best.values(), key=lambda r: r.score, reverse=True)
    return ranked[:limit]


__all__ = [
    "GeocodeResult",
    "GeocoderProtocol",
    "haversine_km",
    "merge_results",
]
