"""Chunk 3 — named POI and building rows in the FTS geocoder."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import osmium

from lokidoki.maps.geocode.fts_index import build_index


def _write_poi_fixture(path: Path) -> None:
    """Emit a tiny PBF covering named POI and non-POI cases."""
    if path.exists():
        path.unlink()
    writer = osmium.SimpleWriter(str(path), overwrite=True)

    nodes = [
        osmium.osm.mutable.Node(
            id=1,
            location=(-73.361, 41.141),
            tags={
                "office": "company",
                "name": "Bridgewater Associates",
            },
        ),
        osmium.osm.mutable.Node(
            id=2,
            location=(-72.9279, 41.3083),
            tags={
                "amenity": "restaurant",
                "name": "Sherwood Diner",
            },
        ),
        osmium.osm.mutable.Node(id=10, location=(-73.0690, 41.2430)),
        osmium.osm.mutable.Node(id=11, location=(-73.0688, 41.2430)),
        osmium.osm.mutable.Node(id=12, location=(-73.0688, 41.2428)),
        osmium.osm.mutable.Node(id=13, location=(-73.0690, 41.2428)),
        osmium.osm.mutable.Node(
            id=20,
            location=(-73.0630, 41.2230),
            tags={"name": "Keyless Landmark"},
        ),
        osmium.osm.mutable.Node(
            id=30,
            location=(-73.069, 41.242964),
            tags={
                "office": "company",
                "name": "150 Stiles HQ",
                "addr:housenumber": "150",
                "addr:street": "Stiles St",
                "addr:city": "Milford",
                "addr:state": "CT",
                "addr:postcode": "06460",
            },
        ),
    ]
    for node in nodes:
        writer.add_node(node)

    writer.add_way(osmium.osm.mutable.Way(
        id=100,
        nodes=[10, 11, 12, 13, 10],
        tags={
            "building": "office",
            "name": "Yale Satellite Office",
        },
    ))
    writer.add_way(osmium.osm.mutable.Way(
        id=101,
        nodes=[10, 11, 12, 13, 10],
        tags={"name": "Unnamed Building Shape"},
    ))
    writer.close()


def test_build_index_classifies_named_pois_with_subclass_and_absorbs_address_shadow(tmp_path):
    """Named POIs (including those that also carry ``addr:*`` tags) must
    land as ``poi:<key>:<value>`` rows so hover cards can resolve a
    subclass icon + label. Nameless / unkeyed nodes still fall through
    to the address / unindexed paths."""
    pbf = tmp_path / "poi_sample.osm.pbf"
    db = tmp_path / "geocoder.sqlite"
    _write_poi_fixture(pbf)

    stats = build_index(pbf, db, region_id="us-ct")

    conn = sqlite3.connect(str(db))
    try:
        poi_rows = conn.execute(
            "SELECT osm_id, name, class FROM places "
            "WHERE class LIKE 'poi:%' ORDER BY osm_id"
        ).fetchall()
        keyless = conn.execute(
            "SELECT COUNT(*) FROM places WHERE name = ?",
            ("Keyless Landmark",),
        ).fetchone()[0]
        n30_rows = conn.execute(
            "SELECT class, COUNT(*) FROM places WHERE osm_id = ? GROUP BY class",
            ("n30",),
        ).fetchall()
    finally:
        conn.close()

    assert ("n1", "Bridgewater Associates", "poi:office:company") in poi_rows
    assert ("n2", "Sherwood Diner", "poi:amenity:restaurant") in poi_rows
    assert ("w100", "Yale Satellite Office", "poi:building:office") in poi_rows
    assert keyless == 0
    # n30 has both ``name`` + POI tags AND ``addr:*`` tags; the POI row
    # absorbs the address shadow so there's exactly one row, class
    # ``poi:office:company``.
    assert n30_rows == [("poi:office:company", 1)]
    assert stats.pois == 4
    assert stats.addresses == 0
