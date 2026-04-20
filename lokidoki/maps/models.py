"""Runtime data models for map region config, state, and install progress.

``MapArchiveConfig`` captures the user's selection (which regions are
enabled). ``MapRegionState`` is the on-disk reality — what artifacts
actually exist and how big they are. ``MapInstallProgress`` is the
shape sent over SSE while an install is in flight.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class MapArchiveConfig:
    """One row in ``data/maps_config.json`` — admin's intent per region."""

    region_id: str
    street: bool = False

    @property
    def any_selected(self) -> bool:
        return self.street


@dataclass
class MapRegionState:
    """One row in ``data/maps_state.json`` — what is actually on disk."""

    region_id: str
    street_installed: bool = False
    valhalla_installed: bool = False
    pbf_installed: bool = False
    geocoder_installed: bool = False
    openaddresses_installed: bool = False
    # Per-artifact bytes on disk — used by the /storage aggregate.
    bytes_on_disk: dict[str, int] = field(default_factory=dict)
    installed_at: str | None = None        # ISO timestamp of last completed install.


@dataclass
class MapInstallProgress:
    """Single SSE event emitted by ``store.install_region``.

    ``artifact`` values: ``"street"``, ``"pbf"``, ``"valhalla"``,
    ``"geocoder"``, ``"done"``, ``"error"``, ``"cancelled"``.

    ``phase`` values after maps-local-build chunk 3:

      * ``"resolving"`` / ``"downloading"`` / ``"verifying"`` — PBF fetch.
      * ``"building_geocoder"`` — FTS geocoder build.
      * ``"building_streets"`` — tippecanoe producing ``streets.pmtiles``.
      * ``"building_routing"`` — ``valhalla_build_tiles`` producing the
        routing tile tree.
      * ``"ready"`` — per-artifact success.
      * ``"complete"`` — end-of-install event (carries ``error`` on failure).

    For the two build phases, ``bytes_done`` / ``bytes_total`` are
    repurposed as ``step_done`` / ``step_total`` (typically 0..100 for
    tippecanoe percent, or stage counters for valhalla) so the admin
    UI's existing percent render keeps working without a new field.
    """

    region_id: str
    artifact: str
    bytes_done: int = 0
    bytes_total: int = 0
    phase: str = "downloading"
    error: str | None = None
