"""Chunk 5 — FTS5 geocoder index build tests.

The fixture PBF is synthesised at test-time with ``osmium.SimpleWriter``
rather than checked in as binary so the repo stays text-friendly. A
handful of nodes covers every code path in ``_address_row``,
``_settlement_row`` and ``_postcode_row``.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import osmium
import pytest

from lokidoki.maps.geocode.fts_index import IndexStats, build_index, row_counts


def _write_ct_fixture(path: Path) -> None:
    """Emit a tiny Connecticut-shaped PBF at ``path``.

    Nodes:
      1 — full address: 150 Stiles St, Milford, CT 06460
      2 — full address: 12 Main St, Hartford, CT 06103
      3 — settlement:   place=city Hartford
      4 — settlement:   place=town Milford
      5 — address with no number (skipped)
    """
    if path.exists():
        path.unlink()
    w = osmium.SimpleWriter(str(path), overwrite=True)

    nodes = [
        osmium.osm.mutable.Node(
            id=1, location=(-73.069, 41.242964),
            tags={
                "addr:housenumber": "150",
                "addr:street": "Stiles St",
                "addr:city": "Milford",
                "addr:state": "CT",
                "addr:postcode": "06460",
                "name": "150 Stiles St",
            },
        ),
        osmium.osm.mutable.Node(
            id=2, location=(-72.685, 41.763),
            tags={
                "addr:housenumber": "12",
                "addr:street": "Main St",
                "addr:city": "Hartford",
                "addr:state": "CT",
                "addr:postcode": "06103",
            },
        ),
        osmium.osm.mutable.Node(
            id=3, location=(-72.6734, 41.7658),
            tags={
                "place": "city",
                "name": "Hartford",
                "is_in:state": "Connecticut",
            },
        ),
        osmium.osm.mutable.Node(
            id=4, location=(-73.0637, 41.2215),
            tags={
                "place": "town",
                "name": "Milford",
                "is_in:state": "Connecticut",
            },
        ),
        osmium.osm.mutable.Node(
            id=5, location=(-72.9, 41.5),
            tags={"addr:street": "Incomplete Rd"},
        ),
    ]
    for n in nodes:
        w.add_node(n)
    w.close()


@pytest.fixture()
def ct_pbf(tmp_path) -> Path:
    path = tmp_path / "ct_sample.osm.pbf"
    _write_ct_fixture(path)
    return path


def test_build_index_produces_expected_row_counts(ct_pbf, tmp_path):
    db = tmp_path / "geocoder.sqlite"
    stats = build_index(ct_pbf, db, region_id="us-ct")

    assert isinstance(stats, IndexStats)
    assert stats.addresses == 2, "two complete addresses should index"
    assert stats.settlements == 2, "Hartford + Milford settlements"
    assert stats.postcodes == 0, "no boundary=postal_code in fixture"
    assert stats.total == 4


def test_build_index_persists_schema_and_rows(ct_pbf, tmp_path):
    db = tmp_path / "geocoder.sqlite"
    build_index(ct_pbf, db, region_id="us-ct")

    conn = sqlite3.connect(str(db))
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(places)").fetchall()]
        assert "name" in cols and "street" in cols and "city" in cols
        total = conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        assert total == 4
        regions = {r[0] for r in conn.execute("SELECT region FROM places")}
        assert regions == {"us-ct"}
    finally:
        conn.close()


def test_build_index_round_trip_on_known_address(ct_pbf, tmp_path):
    db = tmp_path / "geocoder.sqlite"
    build_index(ct_pbf, db, region_id="us-ct")

    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT name, housenumber, street, city, postcode "
            "FROM places WHERE places MATCH ? ORDER BY bm25(places)",
            ('"stiles"',),
        ).fetchall()
    finally:
        conn.close()

    assert rows, "expected at least one MATCH hit for 'stiles'"
    name, house, street, city, postcode = rows[0]
    assert house == "150"
    assert street == "Stiles St"
    assert city == "Milford"
    assert postcode == "06460"


def test_build_index_missing_pbf_raises(tmp_path):
    db = tmp_path / "geocoder.sqlite"
    with pytest.raises(FileNotFoundError):
        build_index(tmp_path / "missing.osm.pbf", db, region_id="us-ct")


def test_row_counts_matches_build(ct_pbf, tmp_path):
    db = tmp_path / "geocoder.sqlite"
    stats = build_index(ct_pbf, db, region_id="us-ct")
    observed = row_counts(db)
    assert observed.addresses == stats.addresses
    assert observed.settlements == stats.settlements
    assert observed.postcodes == stats.postcodes
