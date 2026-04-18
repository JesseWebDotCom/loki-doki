"""Static catalog of map regions available for offline install.

One entry per selectable region — continents are parent-only scaffolds
(zero bytes, no URLs); countries and US states carry the download
templates and sha256s used by :mod:`lokidoki.maps.store`.

The catalog itself is populated in :mod:`lokidoki.maps.seed` so the
dataclass / lookup layer stays importable without parsing the 50-state
size table.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# Env var that lets a self-hoster point the installer at their own
# artifact bucket before the real CDN exists. Sub-chunk 8a fix for the
# Chunk-6 deferral: the default points at a stub that does not resolve,
# which is why an install with zero config appears to "do nothing".
DIST_BASE_ENV = "LOKIDOKI_MAPS_DIST_BASE"
DEFAULT_DIST_BASE = "https://dist.lokidoki.app/maps"


def dist_base() -> str:
    """Current base URL the region catalog builds artifact URLs under.

    Reads ``LOKIDOKI_MAPS_DIST_BASE`` on every call so a process that
    exports the env var after boot still picks up the override on the
    next catalog rebuild.
    """
    return os.environ.get(DIST_BASE_ENV) or DEFAULT_DIST_BASE


def is_stub_dist() -> bool:
    """True when the default (non-existent) dist host is active."""
    return dist_base() == DEFAULT_DIST_BASE


@dataclass(frozen=True)
class MapRegion:
    """One selectable map region.

    ``pi_local_build_ok`` is a catalog-authored boolean: ``True`` iff
    ``pbf_size_mb < 500`` (roughly state-scale). Chunk 6 refuses local
    Valhalla tile builds for ``False`` regions regardless of the user's
    ``allow_local_build`` flag and always pulls the prebuilt tarball.
    """

    region_id: str
    label: str
    parent_id: str | None
    center_lat: float
    center_lon: float
    bbox: tuple[float, float, float, float]  # (minLon, minLat, maxLon, maxLat)
    # Streets + satellite — distributed as artifacts.
    street_size_mb: float
    satellite_size_mb: float
    street_url_template: str
    satellite_url_template: str
    street_sha256: str
    satellite_sha256: str | None
    # Routing — prebuilt tiles always available; .pbf only when local build allowed.
    valhalla_size_mb: float
    valhalla_url_template: str
    valhalla_sha256: str
    pbf_size_mb: float
    pbf_url_template: str
    pbf_sha256: str
    pi_local_build_ok: bool

    @property
    def is_parent_only(self) -> bool:
        """True for catalog scaffolding entries with no downloadable artifacts."""
        return self.street_url_template == ""


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
