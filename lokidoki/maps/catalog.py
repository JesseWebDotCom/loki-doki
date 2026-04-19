"""Static catalog of map regions available for offline install.

One entry per selectable region — continents are parent-only scaffolds
(zero bytes, no URLs); countries and US states carry the Geofabrik
``.osm.pbf`` URL used by :mod:`lokidoki.maps.store`. Every other
artifact (PMTiles, routing graph, FTS geocoder) is built locally from
that PBF in the install pipeline.

The catalog itself is populated in :mod:`lokidoki.maps.seed` so the
dataclass / lookup layer stays importable without parsing the 50-state
size table.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MapRegion:
    """One selectable map region.

    ``pi_local_build_ok`` is a catalog-authored boolean: ``True`` iff
    ``pbf_size_mb < 500`` (roughly state-scale). The install pipeline
    refuses local Valhalla / PMTiles builds for ``False`` regions on
    Pi hardware regardless of the user's preferences.
    """

    region_id: str
    label: str
    parent_id: str | None
    center_lat: float
    center_lon: float
    bbox: tuple[float, float, float, float]  # (minLon, minLat, maxLon, maxLat)
    # Approximate on-disk footprint after local build (for the admin UI).
    street_size_mb: float
    valhalla_size_mb: float
    # The one real download — OpenStreetMap PBF from Geofabrik.
    pbf_size_mb: float
    pbf_url_template: str
    pbf_sha256: str
    pi_local_build_ok: bool

    @property
    def is_parent_only(self) -> bool:
        """True for catalog scaffolding entries with no downloadable artifacts."""
        return self.pbf_url_template == ""


# Populated by :mod:`lokidoki.maps.seed` at import time.
MAP_CATALOG: dict[str, MapRegion] = {}


def get_region(region_id: str) -> MapRegion | None:
    """Look up a region by id. Returns None if unknown."""
    return MAP_CATALOG.get(region_id)


def children_of(parent_id: str | None) -> list[MapRegion]:
    """Direct children of a parent region (or roots when ``parent_id`` is None)."""
    return [r for r in MAP_CATALOG.values() if r.parent_id == parent_id]


def _load_seed() -> None:
    """Populate ``MAP_CATALOG`` from the seed module.

    Deferred to a helper so the seed module can ``from .catalog import
    MapRegion`` without a circular import at module load.
    """
    from . import seed as _seed

    MAP_CATALOG.clear()
    for region in _seed.build_catalog():
        if region.region_id in MAP_CATALOG:
            raise ValueError(f"duplicate region id in seed: {region.region_id}")
        MAP_CATALOG[region.region_id] = region


_load_seed()
