"""Tests for the OpenAddresses ZIP preflight."""
from __future__ import annotations

import asyncio
import hashlib
import zipfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.openaddresses import ensure_openaddresses_for


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def _make_zip_bytes() -> bytes:
    payload = Path("/tmp") / "oa-preflight-fixture.zip"
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("statewide.csv", "LON,LAT,NUMBER,STREET\n-73,41,500,Nyala Farms Road\n")
    data = payload.read_bytes()
    payload.unlink(missing_ok=True)
    return data


def test_ensure_openaddresses_downloads_and_skips_when_present(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _make_zip_bytes()
    sha = hashlib.sha256(payload).hexdigest()
    pin = {
        "us-test": {
            "url": "https://example.test/us-test.zip",
            "sha256": sha,
            "size_bytes": len(payload),
            "filename": "us-test.openaddresses.zip",
        },
    }
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.openaddresses.OPENADDRESSES_REGIONS",
        pin,
    )

    calls: list[tuple[str, Path, str, str | None]] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    out = asyncio.run(ensure_openaddresses_for("us-test", ctx))
    assert out.read_bytes() == payload
    assert calls == [(
        "https://example.test/us-test.zip",
        tmp_path / "maps" / "us-test" / "us-test.openaddresses.zip",
        "download-openaddresses-us-test",
        sha,
    )]

    asyncio.run(ensure_openaddresses_for("us-test", ctx))
    assert len(calls) == 1


def test_ensure_openaddresses_sha_mismatch_raises_and_removes_partial(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _make_zip_bytes()
    pin = {
        "us-test": {
            "url": "https://example.test/us-test.zip",
            "sha256": "0" * 64,
            "size_bytes": len(payload),
            "filename": "us-test.openaddresses.zip",
        },
    }
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.openaddresses.OPENADDRESSES_REGIONS",
        pin,
    )

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        del url, step_id, sha256
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    with pytest.raises(RuntimeError, match="sha256 mismatch"):
        asyncio.run(ensure_openaddresses_for("us-test", _ctx(tmp_path, [])))

    assert not (tmp_path / "maps" / "us-test" / "us-test.openaddresses.zip").exists()


def test_ensure_openaddresses_unknown_region_is_actionable(
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="OPENADDRESSES_REGIONS"):
        asyncio.run(ensure_openaddresses_for("us-test", _ctx(tmp_path, [])))
