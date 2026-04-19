"""Pre-seed planetiler's Natural Earth + OSM water-polygons source archives.

planetiler's ``--download`` flag pulls these two archives from upstream
CDNs at build time. That violates the offline-first invariant — once
bootstrap finishes, the running app and its install pipeline must not
reach the network. This preflight materialises both archives during
bootstrap so ``building_streets`` can run air-gapped.

Layout after install::

    .lokidoki/tools/planetiler/sources/
        natural_earth_vector.sqlite.zip
        water-polygons-split-3857.zip

planetiler reads those zip files directly (see its ``water_polygons_path``
and ``natural_earth_path`` defaults); ``run_planetiler`` passes
``--download_dir=<sources>`` so planetiler looks here instead of the
``data/sources/`` default. No extraction — keeping the zips matches
planetiler's own input contract and avoids doubling on-disk footprint.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import NATURAL_EARTH, OSM_WATER_POLYGONS


_log = logging.getLogger(__name__)
_STEP_ID = "install-planetiler-data"


async def ensure_planetiler_data(ctx: StepContext) -> None:
    """Download Natural Earth + OSM water polygons into ``planetiler_sources``."""
    target = ctx.binary_path("planetiler_sources")
    target.mkdir(parents=True, exist_ok=True)

    ne_path = target / NATURAL_EARTH["filename"]
    wp_path = target / OSM_WATER_POLYGONS["filename"]

    if _present(ne_path) and _present(wp_path):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"planetiler sources already present at {target}",
            )
        )
        return

    if not _present(ne_path):
        url = NATURAL_EARTH["url_template"].format(
            filename=NATURAL_EARTH["filename"]
        )
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"downloading natural earth: {url}")
        )
        await ctx.download(url, ne_path, _STEP_ID, sha256=NATURAL_EARTH["sha256"])

    if not _present(wp_path):
        url = OSM_WATER_POLYGONS["url_template"].format(
            filename=OSM_WATER_POLYGONS["filename"]
        )
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"downloading water polygons: {url}")
        )
        await ctx.download(
            url, wp_path, _STEP_ID, sha256=OSM_WATER_POLYGONS["sha256"]
        )

    if not _present(ne_path) or not _present(wp_path):
        raise RuntimeError(
            f"planetiler sources missing after install under {target}: "
            f"ne={ne_path.exists()} wp={wp_path.exists()}"
        )
    ctx.emit(
        StepLog(step_id=_STEP_ID, line=f"planetiler sources ready at {target}")
    )


def _present(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0
