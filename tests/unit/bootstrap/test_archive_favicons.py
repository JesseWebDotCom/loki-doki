"""Test the archive favicon bootstrap step."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.archive_favicons import ensure_archive_favicons
from lokidoki.archives.catalog import ZIM_CATALOG


def _make_ctx(tmp_path: Path) -> StepContext:
    events: list[Event] = []
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        os_name="darwin",
        arch="arm64",
        emit=events.append,
    )


def test_fetches_all_catalog_entries(tmp_path: Path) -> None:
    """Step should attempt one download per catalog entry."""
    ctx = _make_ctx(tmp_path)
    download_calls: list[str] = []

    async def mock_download(url: str, dest: Path, step_id: str, **kw) -> None:
        download_calls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"fake-icon")

    ctx.download = mock_download  # type: ignore[assignment]
    asyncio.run(ensure_archive_favicons(ctx))

    assert len(download_calls) == len(ZIM_CATALOG)
    favicon_dir = tmp_path / "archives" / "favicons"
    for source in ZIM_CATALOG:
        assert (favicon_dir / f"{source.source_id}.ico").exists()


def test_skips_cached_favicons(tmp_path: Path) -> None:
    """Already-cached icons should not be re-downloaded."""
    ctx = _make_ctx(tmp_path)
    favicon_dir = tmp_path / "archives" / "favicons"
    favicon_dir.mkdir(parents=True, exist_ok=True)

    for source in ZIM_CATALOG:
        (favicon_dir / f"{source.source_id}.ico").write_bytes(b"cached")

    download_calls: list[str] = []

    async def mock_download(url: str, dest: Path, step_id: str, **kw) -> None:
        download_calls.append(url)

    ctx.download = mock_download  # type: ignore[assignment]
    asyncio.run(ensure_archive_favicons(ctx))

    assert len(download_calls) == 0


def test_failure_is_non_fatal(tmp_path: Path) -> None:
    """A single favicon failure should not abort the step."""
    ctx = _make_ctx(tmp_path)
    call_count = 0

    async def mock_download(url: str, dest: Path, step_id: str, **kw) -> None:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise ConnectionError("network down")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"icon")

    ctx.download = mock_download  # type: ignore[assignment]
    asyncio.run(ensure_archive_favicons(ctx))

    assert call_count == len(ZIM_CATALOG)
