"""OpenAddresses ZIP ingest tests for the FTS geocoder."""
from __future__ import annotations

import csv
import io
import zipfile

import pytest

from lokidoki.maps.geocode.fts_index import region_db_path
from lokidoki.maps.geocode.fts_search import search
from lokidoki.maps.geocode.oa_ingest import ingest_openaddresses


def _write_oa_zip(path) -> None:
    csv_buf = io.StringIO()
    writer = csv.writer(csv_buf)
    writer.writerow([
        "LON", "LAT", "NUMBER", "STREET", "UNIT", "CITY",
        "DISTRICT", "REGION", "POSTCODE", "ID", "HASH",
    ])
    writer.writerow([
        "-73.3644", "41.1187", "500", "NYALA FARMS ROAD", "",
        "Westport", "", "CT", "06880", "1", "nyala-500",
    ])
    writer.writerow([
        "-72.6850", "41.7630", "12", "MAIN ST", "", "Hartford",
        "", "CT", "06103", "2", "main-12",
    ])
    writer.writerow([
        "-73.5392", "41.0534", "1", "STATE ST", "", "Bridgeport",
        "", "CT", "06604", "3", "state-1",
    ])

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("us-ct.csv", csv_buf.getvalue())


@pytest.mark.anyio
async def test_ingest_openaddresses_round_trips_search_hit(tmp_path):
    oa_zip = tmp_path / "us-ct.openaddresses.zip"
    _write_oa_zip(oa_zip)
    db_path = region_db_path(tmp_path, "us-ct")

    stats = ingest_openaddresses(oa_zip, db_path, "us-ct")

    assert stats.rows == 3

    hits = await search(
        "500 nyala farms",
        (41.1187, -73.3644),
        ["us-ct"],
        data_root=tmp_path,
    )

    assert hits
    top = hits[0]
    assert "500 nyala farms road" in top.title.lower()
    assert "westport" in top.subtitle.lower()
