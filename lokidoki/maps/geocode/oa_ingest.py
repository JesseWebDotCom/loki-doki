"""Stream OpenAddresses ZIP exports into the geocoder FTS index."""
from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .fts_index import _Row, _flush, _open_db

_BATCH_SIZE = 5000


@dataclass(frozen=True)
class IngestStats:
    """Counts surfaced to the maps install pipeline."""

    rows: int = 0
    skipped: int = 0


def _csv_member(zip_path: Path) -> str:
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if not info.is_dir() and info.filename.lower().endswith(".csv"):
                return info.filename
    raise FileNotFoundError(f"no CSV found in {zip_path}")


def _clean_text(value: str) -> str:
    return " ".join(value.split()).strip()


def _street(value: str) -> str:
    return _clean_text(value).title()


def _latlon(row: dict[str, str]) -> tuple[float, float] | None:
    try:
        return float(row["LAT"]), float(row["LON"])
    except (KeyError, TypeError, ValueError):
        return None


def _oa_row(
    row: dict[str, str],
    region_id: str,
    seq: int,
) -> _Row | None:
    street = _street(row.get("STREET", ""))
    coords = _latlon(row)
    if not street or coords is None:
        return None
    lat, lon = coords
    housenumber = _clean_text(row.get("NUMBER", ""))
    city = _clean_text(row.get("CITY", ""))
    postcode = _clean_text(row.get("POSTCODE", ""))
    admin1 = _clean_text(row.get("REGION", ""))
    stable_hash = _clean_text(row.get("HASH", ""))
    name = f"{housenumber} {street}".strip()
    return _Row(
        osm_id=f"oa:{stable_hash or f'{region_id}:{seq}'}",
        name=name,
        housenumber=housenumber,
        street=street,
        city=city,
        postcode=postcode,
        admin1=admin1,
        lat=lat,
        lon=lon,
        klass="address",
    )


def ingest_openaddresses(
    zip_path: Path,
    output_db: Path,
    region_id: str,
    progress_cb: Callable[[int, str], None] | None = None,
) -> IngestStats:
    """Append OpenAddresses rows from ``zip_path`` into ``output_db``."""
    csv_name = _csv_member(zip_path)
    conn = _open_db(output_db)
    batch: list[_Row] = []
    stats = IngestStats()

    if progress_cb is not None:
        progress_cb(0, "indexing")

    try:
        with zipfile.ZipFile(zip_path) as archive:
            with archive.open(csv_name, "r") as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
                reader = csv.DictReader(text)
                for seq, row in enumerate(reader, start=1):
                    place = _oa_row(row, region_id, seq)
                    if place is None:
                        stats = IngestStats(
                            rows=stats.rows,
                            skipped=stats.skipped + 1,
                        )
                        continue
                    batch.append(place)
                    stats = IngestStats(
                        rows=stats.rows + 1,
                        skipped=stats.skipped,
                    )
                    if len(batch) >= _BATCH_SIZE:
                        _flush(conn, region_id, batch)
                        if progress_cb is not None:
                            progress_cb(stats.rows, "indexing")

        _flush(conn, region_id, batch)
        if progress_cb is not None:
            progress_cb(stats.rows, "ready")
        return stats
    finally:
        conn.close()


__all__ = ["IngestStats", "ingest_openaddresses"]
