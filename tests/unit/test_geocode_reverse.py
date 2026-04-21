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
