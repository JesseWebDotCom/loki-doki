from __future__ import annotations

from pathlib import Path

import osmium
import pytest

from lokidoki.maps.geocode.fts_index import build_index, region_db_path
from lokidoki.maps.geocode.fts_search import nearest


@pytest.fixture()
def anyio_backend() -> str:
    return "asyncio"


def _emit(path: Path, nodes: list[osmium.osm.mutable.Node]) -> None:
    if path.exists():
        path.unlink()
    writer = osmium.SimpleWriter(str(path), overwrite=True)
    for node in nodes:
        writer.add_node(node)
    writer.close()


@pytest.fixture()
def reverse_region_db(tmp_path: Path) -> Path:
    ct_pbf = tmp_path / "ct.osm.pbf"
    ny_pbf = tmp_path / "ny.osm.pbf"

    _emit(ct_pbf, [
        osmium.osm.mutable.Node(
            id=101,
            location=(-73.36440, 41.11870),
            tags={
                "addr:housenumber": "500",
                "addr:street": "Nyala Farms Road",
                "addr:city": "Westport",
                "addr:state": "CT",
                "addr:postcode": "06880",
            },
        ),
        osmium.osm.mutable.Node(
            id=102,
            location=(-73.36440, 41.11870),
            tags={
                "name": "Bridgewater Associates",
                "office": "company",
            },
        ),
    ])
    _emit(ny_pbf, [
        osmium.osm.mutable.Node(
            id=201,
            location=(-73.75620, 42.65260),
            tags={
                "addr:housenumber": "12",
                "addr:street": "Main St",
                "addr:city": "Albany",
                "addr:state": "NY",
                "addr:postcode": "12207",
            },
        ),
    ])

    build_index(ct_pbf, region_db_path(tmp_path, "us-ct"), "us-ct")
    build_index(ny_pbf, region_db_path(tmp_path, "us-ny"), "us-ny")
    return tmp_path


@pytest.mark.anyio
async def test_nearest_returns_exact_coord_hit(reverse_region_db: Path, tmp_path: Path):
    hit = await nearest(
        41.11870,
        -73.36440,
        ["us-ct"],
        data_root=tmp_path,
    )
    assert hit is not None
    assert hit.place_id.startswith("us-ct:osm:")
    assert hit.title == "500 Nyala Farms Road"


@pytest.mark.anyio
async def test_nearest_prefers_address_over_poi_at_same_coord(
    reverse_region_db: Path,
    tmp_path: Path,
):
    hit = await nearest(
        41.11870,
        -73.36440,
        ["us-ct"],
        data_root=tmp_path,
    )
    assert hit is not None
    assert hit.title == "500 Nyala Farms Road"
    assert "Bridgewater Associates" not in hit.title


@pytest.mark.anyio
async def test_nearest_returns_none_outside_radius(reverse_region_db: Path, tmp_path: Path):
    hit = await nearest(
        41.11965,
        -73.36440,
        ["us-ct"],
        data_root=tmp_path,
    )
    assert hit is None


@pytest.mark.anyio
async def test_nearest_uses_rtree_when_present(tmp_path: Path):
    """Nearest queries must hit the R-Tree on fresh indexes — a regression
    here would re-introduce the 1–2 s hover delay against a million-row
    state index."""
    import sqlite3

    pbf = tmp_path / "rtree.osm.pbf"
    if pbf.exists():
        pbf.unlink()
    writer = osmium.SimpleWriter(str(pbf), overwrite=True)
    writer.add_node(osmium.osm.mutable.Node(
        id=1,
        location=(-73.0690, 41.2430),
        tags={
            "addr:housenumber": "150",
            "addr:street": "Stiles St",
            "addr:city": "Milford",
            "addr:state": "CT",
            "addr:postcode": "06460",
        },
    ))
    writer.close()
    db = region_db_path(tmp_path, "us-ct")
    build_index(pbf, db, "us-ct")

    conn = sqlite3.connect(str(db))
    try:
        rtree_rows = conn.execute("SELECT COUNT(*) FROM places_rtree").fetchone()[0]
    finally:
        conn.close()
    assert rtree_rows == 1, "build_index must populate places_rtree"

    hit = await nearest(41.2430, -73.0690, ["us-ct"], data_root=tmp_path)
    assert hit is not None
    assert hit.title == "150 Stiles St"


@pytest.mark.anyio
async def test_nearest_backfills_rtree_for_legacy_indexes(tmp_path: Path):
    """Upgrading users have .sqlite files from before the rtree schema.
    The first query must lazily re-create + populate the rtree so
    subsequent calls hit the fast path."""
    import sqlite3

    from lokidoki.maps.geocode import fts_search

    pbf = tmp_path / "legacy.osm.pbf"
    if pbf.exists():
        pbf.unlink()
    writer = osmium.SimpleWriter(str(pbf), overwrite=True)
    writer.add_node(osmium.osm.mutable.Node(
        id=1,
        location=(-73.0690, 41.2430),
        tags={
            "addr:housenumber": "150",
            "addr:street": "Stiles St",
            "addr:city": "Milford",
            "addr:state": "CT",
            "addr:postcode": "06460",
        },
    ))
    writer.close()
    db = region_db_path(tmp_path, "us-ct")
    build_index(pbf, db, "us-ct")

    conn = sqlite3.connect(str(db))
    try:
        conn.execute("DROP TABLE places_rtree")
        conn.commit()
    finally:
        conn.close()
    # Drop the per-path memo so the backfill actually runs.
    fts_search._BACKFILLED_DBS.discard(db)

    hit = await nearest(41.2430, -73.0690, ["us-ct"], data_root=tmp_path)
    assert hit is not None
    assert hit.title == "150 Stiles St"

    conn = sqlite3.connect(str(db))
    try:
        count = conn.execute("SELECT COUNT(*) FROM places_rtree").fetchone()[0]
    finally:
        conn.close()
    assert count == 1, "backfill must re-materialise the rtree for legacy DBs"


@pytest.mark.anyio
async def test_named_poi_with_addr_tags_exposes_street_in_subtitle(tmp_path: Path):
    """A named POI that also carries addr:housenumber/street must surface the
    street address in the result's subtitle — otherwise the hover card and
    PlaceDetailsCard have no way to show the user where the business is."""
    pbf = tmp_path / "poi_with_addr.osm.pbf"
    if pbf.exists():
        pbf.unlink()
    writer = osmium.SimpleWriter(str(pbf), overwrite=True)
    writer.add_node(osmium.osm.mutable.Node(
        id=1,
        location=(-73.36440, 41.11870),
        tags={
            "office": "company",
            "name": "Bridgewater Associates",
            "addr:housenumber": "500",
            "addr:street": "Nyala Farms Road",
            "addr:city": "Westport",
            "addr:state": "CT",
            "addr:postcode": "06880",
        },
    ))
    writer.close()

    build_index(pbf, region_db_path(tmp_path, "us-ct"), "us-ct")
    hit = await nearest(
        41.11870,
        -73.36440,
        ["us-ct"],
        data_root=tmp_path,
        max_radius_km=0.1,
    )
    assert hit is not None
    assert hit.title == "Bridgewater Associates"
    assert "500 Nyala Farms Road" in hit.subtitle
    assert "Westport" in hit.subtitle


@pytest.mark.anyio
async def test_nearest_fans_out_across_regions(reverse_region_db: Path, tmp_path: Path):
    hit = await nearest(
        42.65261,
        -73.75619,
        ["us-ct", "us-ny"],
        data_root=tmp_path,
    )
    assert hit is not None
    assert hit.place_id.startswith("us-ny:osm:")
    assert hit.subtitle == "Albany, NY, 12207"
