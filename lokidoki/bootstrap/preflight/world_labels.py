"""Build the static ``world-labels.geojson`` from Natural Earth.

Why this exists
---------------
The ``build-world-overview`` preflight (chunk 1 of the world-overview
plan) produces a global z0–z7 vector tileset. That file carries Natural
Earth's **boundaries** and **water polygons** globally — but planetiler's
OpenMapTiles profile sources the ``place`` source-layer (country / state
/ city labels) from **OSM**, not Natural Earth. Because we feed it a
tiny Monaco PBF to satisfy its OSM-input requirement, the only country
label that survives into the tileset is Monaco. No USA, no Canada, no
anything else.

Rather than swap the OSM input for a 20+ GB planet file (impossible
offline), we sidestep the planetiler pipeline entirely for labels:
query the NE sqlite directly for country + state centroids + names,
write them to a single static GeoJSON FeatureCollection, and let
MapLibre render it as a ``geojson`` source. ~300 KB total, loads once.

Layout after install::

    .lokidoki/tools/planetiler/
        world-labels.geojson        # ~300 KB FeatureCollection

Schema — each feature is a ``Point`` with properties:
    kind:       "country" | "state"
    name:       primary label text (prefers ``name_en``)
    name_local: fallback local name
    iso_a2:     two-letter country code (when available)
    admin:      parent country name (``state`` features only)
    rank:       Natural Earth ``labelrank`` (1=most important, 10=least)
    min_zoom:   lowest zoom the label may paint at (from NE ``min_label``)
    max_zoom:   highest zoom the label may paint at (from NE ``max_label``)

The MapLibre style filters on ``kind`` + ``min_zoom``/``max_zoom`` to
stage labels across zooms 0–7 without having to re-generate the file.
"""
from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

from ..context import StepContext
from ..events import StepLog
from ..versions import NATURAL_EARTH


_log = logging.getLogger(__name__)
_STEP_ID = "build-world-labels"

# Skip the rebuild if an existing file is above this size. Any smaller
# means a prior run aborted mid-write — re-generate.
_SKIP_MIN_BYTES = 4 * 1024

# Fresh-build smoke floor is feature-count-based rather than byte-count:
# a minimal test fixture with 4 features lands around 1 KB of JSON even
# though a real bootstrap run produces ~300 KB. What we actually care
# about is "did the sqlite queries return something meaningful", which
# is a count check.
_SMOKE_MIN_FEATURES = 2

# Only include states whose NE ``min_label`` is at or below this zoom.
# NE labels states with min_label 3–10; capping at 10 keeps the long
# tail of smaller admin-1 regions available when users zoom into a
# region and still trims obvious noise.
_STATE_MIN_LABEL_CAP = 10

# Upper bound for country min_zoom we accept. Anything above 8 stays
# too small to matter for this overlay; lower-ranked countries still
# get a chance to paint when their per-feature min/max allows it.
_COUNTRY_MIN_LABEL_CAP = 8


async def ensure_world_labels(ctx: StepContext) -> None:
    """Emit ``world-labels.geojson`` from the Natural Earth sqlite."""
    out_path = ctx.binary_path("world_labels_geojson")
    if _present_above(out_path, _SKIP_MIN_BYTES):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"world-labels geojson already present at {out_path} "
                    f"({out_path.stat().st_size} bytes)"
                ),
            )
        )
        return

    sources_dir = ctx.binary_path("planetiler_sources")
    if not sources_dir.is_dir():
        raise RuntimeError(
            f"planetiler sources directory missing at {sources_dir} — "
            "re-run ./run.sh --maps-tools-only so install-planetiler-data "
            "seeds the Natural Earth sqlite first"
        )
    ne_zip = sources_dir / NATURAL_EARTH["filename"]
    if not ne_zip.is_file():
        raise RuntimeError(
            f"Natural Earth archive missing at {ne_zip} — re-run "
            "./run.sh --maps-tools-only"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=f"extracting Natural Earth sqlite from {ne_zip.name}",
        )
    )

    with tempfile.TemporaryDirectory(prefix="ld-ne-") as tmp:
        sqlite_path = _extract_ne_sqlite(ne_zip, Path(tmp))
        features = list(_collect_features(sqlite_path))

    country_count = sum(1 for f in features if f["properties"]["kind"] == "country")
    state_count = sum(1 for f in features if f["properties"]["kind"] == "state")
    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=(
                f"collected {country_count} country + {state_count} state "
                "labels from Natural Earth"
            ),
        )
    )

    if len(features) < _SMOKE_MIN_FEATURES:
        raise RuntimeError(
            f"world-labels geojson suspiciously small ({len(features)} features) — "
            "Natural Earth sqlite returned no rows; re-run bootstrap to retry"
        )

    scratch = out_path.with_name(f"{out_path.stem}.partial{out_path.suffix}")
    if scratch.exists():
        scratch.unlink()

    payload = {"type": "FeatureCollection", "features": features}
    scratch.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    if out_path.exists():
        out_path.unlink()
    scratch.replace(out_path)

    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=(
                f"world-labels geojson ready at {out_path} "
                f"({out_path.stat().st_size} bytes)"
            ),
        )
    )


def _extract_ne_sqlite(zip_path: Path, dest_dir: Path) -> Path:
    """Extract the ``*.sqlite`` payload from the NE archive into ``dest_dir``."""
    with zipfile.ZipFile(zip_path) as zf:
        sqlite_name = next(
            (n for n in zf.namelist() if n.endswith(".sqlite")),
            None,
        )
        if sqlite_name is None:
            raise RuntimeError(
                f"no .sqlite entry inside {zip_path.name} — archive layout "
                "changed; refresh NATURAL_EARTH pin"
            )
        zf.extract(sqlite_name, dest_dir)
    # Move the extracted file to a predictable path so callers don't
    # have to know the archive's internal directory layout.
    extracted = dest_dir / sqlite_name
    final = dest_dir / "ne.sqlite"
    shutil.move(str(extracted), final)
    return final


def _collect_features(sqlite_path: Path) -> Iterable[dict]:
    """Yield country + state label features from the NE sqlite."""
    con = sqlite3.connect(sqlite_path)
    con.row_factory = sqlite3.Row
    try:
        yield from _country_features(con)
        yield from _state_features(con)
    finally:
        con.close()


def _country_features(con: sqlite3.Connection) -> Iterable[dict]:
    """Build one Point feature per country with a label_x/label_y."""
    cur = con.execute(
        """
        SELECT name, name_en, iso_a2, labelrank, min_label, max_label,
               label_x, label_y
        FROM ne_10m_admin_0_countries
        WHERE label_x IS NOT NULL
          AND label_y IS NOT NULL
          AND min_label <= ?
        """,
        (_COUNTRY_MIN_LABEL_CAP,),
    )
    for row in cur:
        name = (row["name_en"] or row["name"] or "").strip()
        if not name:
            continue
        yield {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(row["label_x"]), float(row["label_y"])],
            },
            "properties": {
                "kind": "country",
                "name": name,
                "name_local": (row["name"] or "").strip(),
                "iso_a2": (row["iso_a2"] or "").strip() or None,
                "rank": int(row["labelrank"]) if row["labelrank"] is not None else 10,
                "min_zoom": _zoom_floor(row["min_label"], default=1),
                "max_zoom": _zoom_floor(row["max_label"], default=22),
            },
        }


def _state_features(con: sqlite3.Connection) -> Iterable[dict]:
    """Build one Point feature per admin-1 state with usable coords."""
    cur = con.execute(
        """
        SELECT name, name_en, iso_a2, admin, labelrank, min_label, max_label,
               latitude, longitude
        FROM ne_10m_admin_1_states_provinces
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND min_label <= ?
        """,
        (_STATE_MIN_LABEL_CAP,),
    )
    for row in cur:
        name = (row["name_en"] or row["name"] or "").strip()
        if not name:
            continue
        yield {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(row["longitude"]), float(row["latitude"])],
            },
            "properties": {
                "kind": "state",
                "name": name,
                "name_local": (row["name"] or "").strip(),
                "iso_a2": (row["iso_a2"] or "").strip() or None,
                "admin": (row["admin"] or "").strip() or None,
                "rank": int(row["labelrank"]) if row["labelrank"] is not None else 10,
                "min_zoom": _zoom_floor(row["min_label"], default=3),
                "max_zoom": _zoom_floor(row["max_label"], default=22),
            },
        }


def _zoom_floor(value, *, default: int) -> int:
    """Coerce a NE ``*_label`` column into an integer zoom, clamped to [0, 15]."""
    if value is None:
        return default
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    if n < 0:
        return 0
    if n > 15:
        return 15
    return n


def _present_above(path: Path, threshold: int) -> bool:
    return path.exists() and path.is_file() and path.stat().st_size >= threshold
