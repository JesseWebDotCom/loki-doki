"""Chunk 5 — FTS5 search ranking + proximity tests.

Covers:

* Prefix tokenisation (``"150 stil*"`` matches "Stiles St").
* Viewport proximity bonus — a CT hit beats a matching NY hit when the
  viewport is Hartford.
* Region filtering — uninstalled regions never return rows even when
  their index file exists on disk.
"""
from __future__ import annotations

from pathlib import Path

import osmium
import pytest

from lokidoki.maps.geocode import GeocodeResult
from lokidoki.maps.geocode.fts_index import build_index, region_db_path
from lokidoki.maps.geocode.fts_search import _dedup_results, search


@pytest.fixture()
def anyio_backend() -> str:
    return "asyncio"


def _emit(path: Path, nodes: list[osmium.osm.mutable.Node]) -> None:
    if path.exists():
        path.unlink()
    w = osmium.SimpleWriter(str(path), overwrite=True)
    for n in nodes:
        w.add_node(n)
    w.close()


@pytest.fixture()
def two_region_db(tmp_path) -> Path:
    """Build two region indices with a shared street name.

    CT has "Main St" in Hartford; NY has "Main St" in Albany. Both
    match the query "main st" — only the proximity penalty can pull
    CT above NY when viewport is near Hartford.
    """
    ct_pbf = tmp_path / "ct.osm.pbf"
    ny_pbf = tmp_path / "ny.osm.pbf"

    _emit(ct_pbf, [
        osmium.osm.mutable.Node(
            id=101, location=(-72.685, 41.763),
            tags={
                "addr:housenumber": "12", "addr:street": "Main St",
                "addr:city": "Hartford", "addr:state": "CT",
            },
        ),
        osmium.osm.mutable.Node(
            id=102, location=(-73.069, 41.242964),
            tags={
                "addr:housenumber": "150", "addr:street": "Stiles St",
                "addr:city": "Milford", "addr:state": "CT",
            },
        ),
    ])
    _emit(ny_pbf, [
        osmium.osm.mutable.Node(
            id=201, location=(-73.7562, 42.6526),
            tags={
                "addr:housenumber": "12", "addr:street": "Main St",
                "addr:city": "Albany", "addr:state": "NY",
            },
        ),
    ])

    # Place under the real on-disk layout so fts_search can find them.
    ct_db = region_db_path(tmp_path, "us-ct")
    ny_db = region_db_path(tmp_path, "us-ny")
    build_index(ct_pbf, ct_db, "us-ct")
    build_index(ny_pbf, ny_db, "us-ny")
    return tmp_path


@pytest.mark.anyio
async def test_prefix_tokenisation_matches_partial_word(two_region_db, tmp_path):
    hits = await search("stil", (41.24, -73.07), ["us-ct"], data_root=tmp_path)
    assert hits, "prefix token 'stil' should match Stiles St"
    assert "stiles" in hits[0].title.lower()


@pytest.mark.anyio
async def test_viewport_proximity_ranks_ct_above_ny(two_region_db, tmp_path):
    hartford = (41.763, -72.685)
    hits = await search(
        "12 main st", hartford, ["us-ct", "us-ny"], data_root=tmp_path,
    )
    assert hits, "expected at least one Main St hit"
    assert hits[0].place_id.startswith("us-ct:"), \
        f"CT should rank first near Hartford, got {hits[0].place_id}"


@pytest.mark.anyio
async def test_region_filter_excludes_uninstalled(two_region_db, tmp_path):
    # Both indices exist on disk, but caller only passes us-ct.
    hartford = (41.763, -72.685)
    hits = await search("main st", hartford, ["us-ct"], data_root=tmp_path)
    assert hits, "CT-only search should still return Hartford hit"
    assert all(h.place_id.startswith("us-ct:") for h in hits), \
        "NY rows must not leak through when NY isn't in the region list"


@pytest.mark.anyio
async def test_state_abbrev_does_not_break_match(two_region_db, tmp_path):
    hartford = (41.763, -72.685)
    hits = await search(
        "main st in CT",
        hartford,
        ["us-ct", "us-ny"],
        data_root=tmp_path,
    )
    assert hits, "expected Main St hit even with stopwords/state abbrev"
    assert hits[0].place_id.startswith("us-ct:"), \
        f"CT should rank first near Hartford, got {hits[0].place_id}"


@pytest.mark.anyio
async def test_stopword_in_does_not_block_match(two_region_db, tmp_path):
    hartford = (41.763, -72.685)
    plain = await search("main st", hartford, ["us-ct", "us-ny"], data_root=tmp_path)
    with_stopword = await search(
        "main st in",
        hartford,
        ["us-ct", "us-ny"],
        data_root=tmp_path,
    )
    assert [hit.place_id for hit in plain] == [hit.place_id for hit in with_stopword]


def test_dedup_collapses_oa_and_osm_at_same_parcel():
    hits = [
        GeocodeResult(
            place_id="us-ct:osm:123",
            title="500 Nyala Farms Road",
            subtitle="Westport, CT",
            lat=41.11870,
            lon=-73.36440,
            bbox=None,
            source="fts",
            score=8.0,
        ),
        GeocodeResult(
            place_id="us-ct:osm:oa:nyala-500",
            title="500 Nyala Farms Road",
            subtitle="Westport, CT",
            lat=41.11876,
            lon=-73.36446,
            bbox=None,
            source="fts",
            score=8.0,
        ),
    ]

    deduped = _dedup_results(hits)

    assert len(deduped) == 1
    assert deduped[0].place_id == "us-ct:osm:oa:nyala-500"


@pytest.mark.anyio
async def test_empty_query_returns_no_results(two_region_db, tmp_path):
    hits = await search("", (41.763, -72.685), ["us-ct"], data_root=tmp_path)
    assert hits == []


@pytest.mark.anyio
async def test_empty_region_list_returns_no_results(two_region_db, tmp_path):
    hits = await search("main", (41.763, -72.685), [], data_root=tmp_path)
    assert hits == []


@pytest.mark.anyio
async def test_search_place_id_format(two_region_db, tmp_path):
    hits = await search("stiles", (41.24, -73.07), ["us-ct"], data_root=tmp_path)
    assert hits
    assert hits[0].source == "fts"
    # Shape: "<region>:osm:<kind+id>"
    assert hits[0].place_id.startswith("us-ct:osm:")
