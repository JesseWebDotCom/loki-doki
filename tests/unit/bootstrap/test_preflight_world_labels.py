"""``ensure_world_labels`` emits a static NE-derived label GeoJSON.

The preflight reads the pinned Natural Earth sqlite (already staged on
disk by ``install-planetiler-data``) and writes a FeatureCollection of
country + state centroids to ``world-labels.geojson``. These tests drive
a tiny in-memory-ish NE database laid out to match the real table shape,
so the preflight never has to shell out, unzip the 1+ GB real archive,
or touch the network.

Cases:

* **Happy path** — two countries + two states land in the geojson,
  correctly shaped, with ``kind`` / ``name`` / ``min_zoom`` / ``max_zoom``.
* **Skip-when-present** — existing above-threshold file short-circuits
  the build (no sqlite access).
* **Tiny-output-fails** — forcing empty query results leaves the scratch
  below the smoke floor; preflight raises + removes the partial.
* **Missing Natural Earth archive** — preflight raises with a message
  pointing at ``--maps-tools-only``.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.world_labels import (
    _SKIP_MIN_BYTES,
    _SMOKE_MIN_FEATURES,
    ensure_world_labels,
)
from lokidoki.bootstrap.versions import NATURAL_EARTH


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
            name TEXT, name_en TEXT, iso_a2 TEXT,
            labelrank INTEGER, min_label REAL, max_label REAL,
            label_x REAL, label_y REAL
        )
        """
    )
    con.executemany(
        "INSERT INTO ne_10m_admin_0_countries VALUES (?,?,?,?,?,?,?,?)",
        countries,
    )
    con.execute(
        """
        CREATE TABLE ne_10m_admin_1_states_provinces (
            name TEXT, name_en TEXT, iso_a2 TEXT, admin TEXT,
            labelrank INTEGER, min_label REAL, max_label REAL,
            latitude REAL, longitude REAL
        )
        """
    )
    con.executemany(
        "INSERT INTO ne_10m_admin_1_states_provinces VALUES (?,?,?,?,?,?,?,?,?)",
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


def test_happy_path_emits_country_and_state_features(tmp_path: Path):
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    _seed_ne_archive(
        sources_dir,
        countries=[
            # name, name_en, iso_a2, labelrank, min_label, max_label, label_x, label_y
            ("United States of America", "United States of America", "US", 1, 2.0, 7.0, -97.48, 39.53),
            ("Canada", "Canada", "CA", 1, 2.0, 7.0, -101.91, 60.32),
            # Skipped — min_label above the cap.
            ("Tiny Island", "Tiny Island", "TI", 5, 9.0, 11.0, 0.0, 0.0),
        ],
        states=[
            # name, name_en, iso_a2, admin, labelrank, min_label, max_label, latitude, longitude
            ("Connecticut", "Connecticut", "US", "United States of America", 4, 5.0, 7.0, 41.52, -72.76),
            ("California", "California", "US", "United States of America", 2, 3.0, 7.0, 36.17, -119.75),
            # Included now that the state min_label cap is lifted to 10.
            ("Unimportant County", "Unimportant County", "US", "United States of America", 7, 10.0, 11.0, 0.0, 0.0),
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

    # Point geometry + lon/lat order.
    for feat in feats:
        assert feat["geometry"]["type"] == "Point"
        lon, lat = feat["geometry"]["coordinates"]
        assert -180 <= lon <= 180
        assert -90 <= lat <= 90

    # min_zoom + max_zoom land as plain ints after rounding.
    for feat in feats:
        props = feat["properties"]
        assert isinstance(props["min_zoom"], int)
        assert isinstance(props["max_zoom"], int)
        assert 0 <= props["min_zoom"] <= 15
        assert 0 <= props["max_zoom"] <= 15


def test_skip_when_present_above_threshold(tmp_path: Path):
    """An existing healthy file short-circuits — no NE zip access needed."""
    out = tmp_path / "tools" / "planetiler" / "world-labels.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"{" + b" " * (_SKIP_MIN_BYTES + 10) + b"}")

    # Deliberately do NOT stage an NE archive — if the preflight tried
    # to use it, the test would raise RuntimeError. The skip path must
    # leave the existing file exactly as-is.
    mtime_before = out.stat().st_mtime_ns

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_world_labels(ctx))

    assert out.read_bytes().startswith(b"{")
    assert out.stat().st_mtime_ns == mtime_before


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


def test_missing_ne_archive_raises_with_pointer(tmp_path: Path):
    sources_dir = tmp_path / "tools" / "planetiler" / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    # No zip on disk.
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="--maps-tools-only"):
        asyncio.run(ensure_world_labels(ctx))
