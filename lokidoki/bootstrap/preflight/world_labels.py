"""Build the static ``world-labels.geojson`` from Natural Earth."""
from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import struct
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

from ..context import StepContext
from ..events import StepLog
from ..versions import NATURAL_EARTH, WORLD_LABELS_VERSION


_log = logging.getLogger(__name__)
_STEP_ID = "build-world-labels"
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
    if _present_current(out_path):
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

    payload = {
        "type": "FeatureCollection",
        "version": WORLD_LABELS_VERSION,
        "features": features,
    }
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
    """Build one polygon feature per country from the NE geometry blob."""
    cur = con.execute(
        """
        SELECT name, name_en, iso_a2, labelrank, min_label, max_label,
               GEOMETRY
        FROM ne_10m_admin_0_countries
        WHERE GEOMETRY IS NOT NULL
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
            "geometry": _decode_wkb(row["GEOMETRY"]),
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
    """Build one polygon feature per admin-1 state from the NE geometry blob."""
    cur = con.execute(
        """
        SELECT name, name_en, iso_a2, admin, labelrank, min_label, max_label,
               GEOMETRY
        FROM ne_10m_admin_1_states_provinces
        WHERE GEOMETRY IS NOT NULL
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
            "geometry": _decode_wkb(row["GEOMETRY"]),
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


def _decode_wkb(blob: bytes) -> dict:
    order = "<" if blob[0] == 1 else ">"
    gtype, offset = _read(blob, f"{order}I", 1)
    if gtype == 3:
        return {"type": "Polygon", "coordinates": _read_polygon(blob, offset, order)}
    if gtype == 6:
        count, offset = _read(blob, f"{order}I", offset)
        polys = []
        for _ in range(count):
            polys.append(_decode_wkb(blob[offset:])["coordinates"])
            offset += _geometry_size(blob[offset:])
        return {"type": "MultiPolygon", "coordinates": polys}
    raise RuntimeError(f"unsupported Natural Earth WKB geometry type {gtype}")


def _read_polygon(blob: bytes, offset: int, order: str) -> list[list[list[float]]]:
    rings_n, offset = _read(blob, f"{order}I", offset)
    rings = []
    for _ in range(rings_n):
        points_n, offset = _read(blob, f"{order}I", offset)
        ring = []
        for _ in range(points_n):
            x, y = struct.unpack_from(f"{order}dd", blob, offset)
            offset += 16
            ring.append([x, y])
        rings.append(ring)
    return rings


def _geometry_size(blob: bytes) -> int:
    order = "<" if blob[0] == 1 else ">"
    gtype, offset = _read(blob, f"{order}I", 1)
    if gtype == 3:
        rings_n, offset = _read(blob, f"{order}I", offset)
        for _ in range(rings_n):
            points_n, offset = _read(blob, f"{order}I", offset)
            offset += points_n * 16
        return offset
    if gtype == 6:
        polys_n, offset = _read(blob, f"{order}I", offset)
        for _ in range(polys_n):
            size = _geometry_size(blob[offset:])
            offset += size
        return offset
    raise RuntimeError(f"unsupported Natural Earth WKB geometry type {gtype}")


def _read(blob: bytes, fmt: str, offset: int) -> tuple[int, int]:
    size = struct.calcsize(fmt)
    return struct.unpack_from(fmt, blob, offset)[0], offset + size


def _present_current(path: Path) -> bool:
    if not path.exists() or not path.is_file() or path.stat().st_size < _SKIP_MIN_BYTES:
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return payload.get("version") == WORLD_LABELS_VERSION
