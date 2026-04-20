"""Tests for low-level map download helpers."""
from __future__ import annotations

import asyncio
import hashlib

import pytest

from lokidoki.maps import store


def test_download_to_skips_network_when_existing_hash_matches(tmp_path, monkeypatch):
    dest = tmp_path / "region.osm.pbf"
    payload = b"existing-pbf"
    dest.write_bytes(payload)
    expected_sha = hashlib.sha256(payload).hexdigest()
    progress_calls: list[tuple[int, int]] = []

    class _UnexpectedClient:
        def __init__(self, *args, **kwargs) -> None:
            raise AssertionError("network should not be used")

    monkeypatch.setattr(store.httpx, "AsyncClient", _UnexpectedClient)

    async def _run() -> int:
        return await store._download_to(
            "https://example.test/us-ct.osm.pbf",
            dest,
            expected_sha,
            lambda done, total: progress_calls.append((done, total)),
            asyncio.Event(),
        )

    written = asyncio.run(_run())

    assert written == len(payload)
    assert progress_calls == [(len(payload), len(payload))]
