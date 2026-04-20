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


def test_build_index_includes_named_pois_and_suppresses_poi_shadow(tmp_path):
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
        address_rows = conn.execute(
            "SELECT class, COUNT(*) FROM places WHERE osm_id = ? GROUP BY class",
            ("n30",),
        ).fetchall()
    finally:
        conn.close()

    assert ("n1", "Bridgewater Associates", "poi:office") in poi_rows
    assert ("n2", "Sherwood Diner", "poi:amenity") in poi_rows
    assert ("w100", "Yale Satellite Office", "poi:building") in poi_rows
    assert keyless == 0
    assert address_rows == [("address", 1)]
    assert stats.pois == 3
