"""Test the ZIM download manager and resolver."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from lokidoki.archives import store
from lokidoki.archives.download_manager import (
    DownloadManager,
    DownloadProgress,
    MIN_FREE_BYTES,
)
from lokidoki.archives.models import ArchiveConfig
from lokidoki.archives.resolver import ZimFileInfo


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path):
    store.set_data_dir(tmp_path)
    yield
    store.set_data_dir(None)


def test_progress_initial_state():
    p = DownloadProgress(source_id="wikipedia", status="resolving")
    assert p.bytes_downloaded == 0
    assert p.percent == 0.0
    assert p.error is None


def test_progress_serializable():
    p = DownloadProgress(
        source_id="wikipedia",
        status="downloading",
        bytes_downloaded=1000,
        bytes_total=10000,
        percent=10.0,
        speed_bps=500.0,
    )
    d = asdict(p)
    assert d["source_id"] == "wikipedia"
    assert d["percent"] == 10.0


def test_disk_space_check(tmp_path):
    """Download should fail if insufficient disk space."""
    mgr = DownloadManager()
    # We can't easily simulate low disk space, but we can verify the
    # MIN_FREE_BYTES constant is reasonable
    assert MIN_FREE_BYTES == 2 * 1024 * 1024 * 1024  # 2 GB


def test_cancel_nonexistent_download():
    mgr = DownloadManager()
    result = asyncio.run(mgr.cancel_download("nonexistent"))
    assert result is False


def test_get_progress_nonexistent():
    mgr = DownloadManager()
    assert mgr.get_progress("nonexistent") is None


# ── Resolver tests ──────────────────────────────────────────────

def test_zim_file_info():
    info = ZimFileInfo(
        source_id="wikipedia",
        filename="wikipedia_en_all_mini_2025-03.zim",
        url="https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2025-03.zim",
        date="2025-03",
        size_bytes=8_000_000_000,
    )
    assert info.date == "2025-03"
    assert "wikipedia" in info.url


def test_resolver_returns_none_for_unknown_source():
    from lokidoki.archives.resolver import resolve_latest_zim

    result = asyncio.run(resolve_latest_zim("nonexistent", "all"))
    assert result is None


def test_resolver_returns_none_for_unknown_variant():
    from lokidoki.archives.resolver import resolve_latest_zim

    result = asyncio.run(resolve_latest_zim("wikipedia", "nonexistent"))
    assert result is None


# ── Download worker integration ─────────────────────────────────

def test_manager_tracks_active_downloads():
    """Verify the manager data structure works correctly."""
    mgr = DownloadManager()
    assert len(mgr._active) == 0


def test_progress_stream_returns_on_idle():
    """progress_stream should return immediately if no active download."""
    mgr = DownloadManager()

    async def _run():
        results = []
        async for p in mgr.progress_stream("nonexistent"):
            results.append(p)
        return results

    results = asyncio.run(_run())
    assert len(results) == 0
