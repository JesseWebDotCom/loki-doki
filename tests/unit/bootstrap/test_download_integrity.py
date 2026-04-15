"""``StepContext.download`` end-to-end against a local HTTPS-free fixture.

We don't have the cert infra to spin up a real HTTPS server inside a unit
test, so we monkey-patch ``urllib.request.urlopen`` inside the blocking
downloader to stream bytes from a local file while keeping the public
HTTPS-only contract intact.
"""
from __future__ import annotations

import hashlib
import io
import platform
import urllib.request
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import IntegrityError, StepContext
from lokidoki.bootstrap.events import Event, StepProgress


class _FakeResponse:
    """Context-manager mimicking ``urlopen`` return value."""

    def __init__(self, data: bytes, url: str = "https://example.invalid/fixture") -> None:
        self._stream = io.BytesIO(data)
        self.headers = {"Content-Length": str(len(data))}
        self.url = url
        self.status = 200

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> None:
        self._stream.close()

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


def _make_ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    def _emit(evt: Event) -> None:
        events.append(evt)

    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch=platform.machine() or "arm64",
        os_name=platform.system(),
        emit=_emit,
    )


def _patch_urlopen(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    def _fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        return _FakeResponse(payload)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", _fake_urlopen
    )


def test_download_matching_sha_renames_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    payload = b"x" * (3 * 1024 * 1024 + 17)  # spans a few 1 MB chunks
    sha = hashlib.sha256(payload).hexdigest()
    _patch_urlopen(monkeypatch, payload)

    events: list[Event] = []
    ctx = _make_ctx(tmp_path, events)
    dest = tmp_path / "out" / "artifact.bin"

    asyncio.run(
        ctx.download(
            url="https://example.invalid/fixture",
            dest=dest,
            step_id="embed-python",
            sha256=sha,
        )
    )

    assert dest.exists() and dest.read_bytes() == payload
    assert not dest.with_name(dest.name + ".part").exists()
    progresses = [e for e in events if isinstance(e, StepProgress)]
    assert progresses, "no StepProgress events emitted"
    assert progresses[-1].bytes_done == len(payload)


def test_download_mismatched_sha_raises_and_removes_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    payload = b"hello world"
    wrong_sha = "0" * 64
    _patch_urlopen(monkeypatch, payload)

    events: list[Event] = []
    ctx = _make_ctx(tmp_path, events)
    dest = tmp_path / "artifact.bin"

    with pytest.raises(IntegrityError):
        asyncio.run(
            ctx.download(
                url="https://example.invalid/fixture",
                dest=dest,
                step_id="embed-python",
                sha256=wrong_sha,
            )
        )

    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_rejects_non_https(tmp_path: Path) -> None:
    import asyncio

    ctx = _make_ctx(tmp_path, [])
    with pytest.raises(IntegrityError):
        asyncio.run(
            ctx.download(
                url="http://example.invalid/fixture",
                dest=tmp_path / "x.bin",
                step_id="embed-python",
            )
        )
