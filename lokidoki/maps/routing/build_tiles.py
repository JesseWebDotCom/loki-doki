"""GraphHopper graph-cache layout helpers.

The install pipeline writes routing data under
``data/maps/<region>/valhalla/graph-cache``. This module validates that
layout before the lazy sidecar touches it.
"""
from __future__ import annotations

from pathlib import Path
from lokidoki.maps import store


def tile_dir(region_id: str) -> Path:
    """Return the expected GraphHopper graph-cache directory."""
    return store.region_dir(region_id) / "valhalla" / "graph-cache"


def ensure_tiles(region_id: str) -> Path:
    """Validate that GraphHopper graph-cache exists on disk."""
    d = tile_dir(region_id)
    if not d.is_dir():
        raise FileNotFoundError(
            f"GraphHopper graph-cache missing for {region_id}: expected {d}",
        )
    if not any(d.iterdir()):
        raise FileNotFoundError(
            f"GraphHopper graph-cache {d} is empty — re-install the region",
        )
    properties = d / "properties"
    if not properties.exists():
        raise FileNotFoundError(
            f"GraphHopper graph-cache {d} is incomplete — missing properties",
        )
    return d

__all__ = ["ensure_tiles", "tile_dir"]
