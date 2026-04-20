"""Tests for the Natural-Earth-backed world label preflight."""
from __future__ import annotations

import asyncio
import json
import sqlite3
import struct
import zipfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.world_labels import (
    _SMOKE_MIN_FEATURES,
    ensure_world_labels,
)
from lokidoki.bootstrap.versions import NATURAL_EARTH, WORLD_LABELS_VERSION


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def _seed_ne_archive(
    sources_dir: Path,
    *,
    countries: list[tuple],
    states: list[tuple],
) -> Path:
    """Build a fake NE zip whose inner sqlite carries only the columns
    the preflight actually selects on. Output matches the real zip layout
    (``packages/<name>.sqlite``) so the extractor's namelist lookup hits.
    """
    sources_dir.mkdir(parents=True, exist_ok=True)
    sqlite_path = sources_dir / "fake_ne.sqlite"
    if sqlite_path.exists():
        sqlite_path.unlink()
    con = sqlite3.connect(sqlite_path)
    con.execute(
        """
        CREATE TABLE ne_10m_admin_0_countries (
            GEOMETRY BLOB,
            name TEXT, name_en TEXT, iso_a2 TEXT,
            labelrank INTEGER, min_label REAL, max_label REAL
        )
        """
    )
    con.executemany(
        "INSERT INTO ne_10m_admin_0_countries VALUES (?,?,?,?,?,?,?)",
        countries,
    )
    con.execute(
        """
        CREATE TABLE ne_10m_admin_1_states_provinces (
            GEOMETRY BLOB,
            name TEXT, name_en TEXT, iso_a2 TEXT, admin TEXT,
            labelrank INTEGER, min_label REAL, max_label REAL
        )
        """
    )
    con.executemany(
        "INSERT INTO ne_10m_admin_1_states_provinces VALUES (?,?,?,?,?,?,?,?)",
        states,
    )
    con.commit()
    con.close()

    zip_path = sources_dir / NATURAL_EARTH["filename"]
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(sqlite_path, arcname="packages/natural_earth_vector.sqlite")
    sqlite_path.unlink()
    return zip_path


def _polygon_blob(*rings: list[tuple[float, float]]) -> bytes:
    blob = bytearray(struct.pack("<BI", 1, 3))
    blob.extend(struct.pack("<I", len(rings)))
    for ring in rings:
        blob.extend(struct.pack("<I", len(ring)))
        for x, y in ring:
            blob.extend(struct.pack("<dd", x, y))
    return bytes(blob)


def _multipolygon_blob(*polygons: list[list[tuple[float, float]]]) -> bytes:
    blob = bytearray(struct.pack("<BI", 1, 6))
    blob.extend(struct.pack("<I", len(polygons)))
    for poly in polygons:
        blob.extend(_polygon_blob(*poly))
    return bytes(blob)


def test_happy_path_emits_country_and_state_features(tmp_path: Path):
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    _seed_ne_archive(
        sources_dir,
        countries=[
            (
                _multipolygon_blob(
                    [[(-125.0, 25.0), (-66.0, 25.0), (-66.0, 49.0), (-125.0, 49.0), (-125.0, 25.0)]],
                ),
                "United States of America",
                "United States of America",
                "US",
                1,
                2.0,
                7.0,
            ),
            (
                _polygon_blob([(-141.0, 49.0), (-52.0, 49.0), (-52.0, 83.0), (-141.0, 83.0), (-141.0, 49.0)]),
                "Canada",
                "Canada",
                "CA",
                1,
                2.0,
                7.0,
            ),
            # Skipped — min_label above the cap.
            (
                _polygon_blob([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]),
                "Tiny Island",
                "Tiny Island",
                "TI",
                5,
                9.0,
                11.0,
            ),
        ],
        states=[
            (
                _polygon_blob([(-73.73, 40.98), (-71.78, 40.98), (-71.78, 42.05), (-73.73, 42.05), (-73.73, 40.98)]),
                "Connecticut",
                "Connecticut",
                "US",
                "United States of America",
                4,
                5.0,
                7.0,
            ),
            (
                _polygon_blob([(-124.48, 32.53), (-114.13, 32.53), (-114.13, 42.01), (-124.48, 42.01), (-124.48, 32.53)]),
                "California",
                "California",
                "US",
                "United States of America",
                2,
                3.0,
                7.0,
            ),
            # Included now that the state min_label cap is lifted to 10.
            (
                _polygon_blob([(0.0, 0.0), (3.0, 0.0), (3.0, 3.0), (0.0, 3.0), (0.0, 0.0)]),
                "Unimportant County",
                "Unimportant County",
                "US",
                "United States of America",
                7,
                10.0,
                11.0,
            ),
        ],
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_labels(ctx))

    out = ctx.binary_path("world_labels_geojson")
    assert out.is_file()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert len(payload["features"]) >= _SMOKE_MIN_FEATURES
    assert payload["type"] == "FeatureCollection"
    assert payload["version"] == WORLD_LABELS_VERSION
    feats = payload["features"]
    kinds = [f["properties"]["kind"] for f in feats]
    names = [f["properties"]["name"] for f in feats]

    assert kinds.count("country") == 2
    assert kinds.count("state") == 3
    assert "United States of America" in names
    assert "Canada" in names
    assert "Connecticut" in names
    assert "California" in names
    assert "Tiny Island" not in names  # excluded by min_label cap
    assert "Unimportant County" in names

    geometry_types = {feat["geometry"]["type"] for feat in feats}
    assert geometry_types & {"Polygon", "MultiPolygon"}
    for feat in feats:
        assert "label_x" not in feat["properties"]
        assert "label_y" not in feat["properties"]
        assert "latitude" not in feat["properties"]
        assert "longitude" not in feat["properties"]

    # min_zoom + max_zoom land as plain ints after rounding.
    for feat in feats:
        props = feat["properties"]
        assert isinstance(props["min_zoom"], int)
        assert isinstance(props["max_zoom"], int)
        assert 0 <= props["min_zoom"] <= 15
        assert 0 <= props["max_zoom"] <= 15


def test_skip_when_present_at_current_version(tmp_path: Path):
    """An existing current-version file short-circuits — no NE zip access needed."""
    out = tmp_path / "tools" / "planetiler" / "world-labels.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "version": WORLD_LABELS_VERSION,
                "features": [],
                "padding": "x" * 5000,
            }
        ),
        encoding="utf-8",
    )

    # Deliberately do NOT stage an NE archive — if the preflight tried
    # to use it, the test would raise RuntimeError. The skip path must
    # leave the existing file exactly as-is.
    mtime_before = out.stat().st_mtime_ns

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_labels(ctx))

    assert out.read_bytes().startswith(b"{")
    assert out.stat().st_mtime_ns == mtime_before


def test_rebuilds_when_existing_file_has_old_version(tmp_path: Path):
    out = tmp_path / "tools" / "planetiler" / "world-labels.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"type": "FeatureCollection", "version": "point-1", "features": []}),
        encoding="utf-8",
    )
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    _seed_ne_archive(
        sources_dir,
        countries=[
            (
                _polygon_blob([(60.0, 41.0), (75.0, 41.0), (75.0, 55.0), (60.0, 55.0), (60.0, 41.0)]),
                "Russia",
                "Russia",
                "RU",
                1,
                2.0,
                7.0,
            )
        ],
        states=[
            (
                _polygon_blob([(30.0, 59.0), (40.0, 59.0), (40.0, 65.0), (30.0, 65.0), (30.0, 59.0)]),
                "Karelia",
                "Karelia",
                "RU",
                "Russia",
                4,
                5.0,
                7.0,
            )
        ],
    )

    asyncio.run(ensure_world_labels(_ctx(tmp_path, [])))

    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["version"] == WORLD_LABELS_VERSION
    assert payload["features"][0]["properties"]["name"] == "Russia"


def test_tiny_output_is_treated_as_corrupt(tmp_path: Path):
    """Zero features → JSON under the smoke floor → build rejected."""
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    _seed_ne_archive(sources_dir, countries=[], states=[])

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="suspiciously small"):
        asyncio.run(ensure_world_labels(ctx))

    out = ctx.binary_path("world_labels_geojson")
    scratch = out.with_name(f"{out.stem}.partial{out.suffix}")
    assert not scratch.exists()
    assert not out.exists()


def test_admin1_polygons_emitted_for_non_us_countries(tmp_path: Path):
    """Mexico / Canada / German / Indian admin-1 polygons must land in the
    geojson so the global ``world_admin1_boundary`` + ``world_admin1_label``
    style layers can render their outlines + names. Regression guard for
    chunk 15 — pre-fix the overview map showed only country outlines outside
    the US because OpenMapTiles seeds NE admin-1 only for ``adm0_a3=USA``.
    """
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    _seed_ne_archive(
        sources_dir,
        countries=[
            (
                _polygon_blob(
                    [(-118.4, 14.5), (-86.7, 14.5), (-86.7, 32.7), (-118.4, 32.7), (-118.4, 14.5)]
                ),
                "Mexico",
                "Mexico",
                "MX",
                2,
                3.0,
                7.0,
            ),
        ],
        states=[
            (
                _polygon_blob(
                    [(-105.7, 18.9), (-101.5, 18.9), (-101.5, 22.7), (-105.7, 22.7), (-105.7, 18.9)]
                ),
                "Jalisco",
                "Jalisco",
                "MX",
                "Mexico",
                4,
                5.0,
                8.0,
            ),
            (
                _polygon_blob(
                    [(-95.0, 41.7), (-74.3, 41.7), (-74.3, 56.9), (-95.0, 56.9), (-95.0, 41.7)]
                ),
                "Ontario",
                "Ontario",
                "CA",
                "Canada",
                3,
                4.0,
                7.0,
            ),
            (
                _polygon_blob(
                    [(8.97, 47.27), (13.84, 47.27), (13.84, 50.56), (8.97, 50.56), (8.97, 47.27)]
                ),
                "Bavaria",
                "Bavaria",
                "DE",
                "Germany",
                3,
                5.0,
                7.0,
            ),
        ],
    )

    asyncio.run(ensure_world_labels(_ctx(tmp_path, [])))

    out = tmp_path / "tools" / "planetiler" / "world-labels.geojson"
    payload = json.loads(out.read_text(encoding="utf-8"))
    state_feats = [f for f in payload["features"] if f["properties"]["kind"] == "state"]
    state_names = {f["properties"]["name"] for f in state_feats}

    assert {"Jalisco", "Ontario", "Bavaria"}.issubset(state_names), (
        f"non-US admin-1 polygons must survive into the geojson; got {state_names}"
    )

    # Geometry must be polygon / multipolygon — line + symbol layers in the
    # MapLibre style depend on that to render outlines + centroid labels.
    for feat in state_feats:
        assert feat["geometry"]["type"] in {"Polygon", "MultiPolygon"}


def test_missing_ne_archive_raises_with_pointer(tmp_path: Path):
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    # No zip on disk.
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="--maps-tools-only"):
        asyncio.run(ensure_world_labels(ctx))
