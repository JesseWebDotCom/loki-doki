"""``ensure_valhalla_tools`` end-to-end against a fabricated tarball.

Mirrors ``test_preflight_tippecanoe`` — forges the ``maps-tools-v1``
release-asset shape (single wrapper dir, ``bin/valhalla_build_tiles``
+ ``bin/valhalla_service`` inside), pipes through the stdlib urlopen
shim, and asserts the binaries land under
``.lokidoki/tools/valhalla/bin/`` with the path registered for
``augmented_env()[\"PATH\"]``.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.valhalla_tools import (
    ensure_valhalla_tools,
    valhalla_build_tiles_path,
    valhalla_service_path,
)
from lokidoki.bootstrap.versions import VALHALLA_TOOLS, os_arch_key


class _FakeResponse:
    def __init__(self, data: bytes, url: str) -> None:
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


def _fake_valhalla_tarball(inner_dir: str) -> bytes:
    """gz tarball carrying a minimal set of Valhalla CLIs + the daemon."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in ("valhalla_build_tiles", "valhalla_build_admins", "valhalla_service"):
            script = b"#!/bin/sh\necho " + name.encode() + b" v3.5.0-test\n"
            info = tarfile.TarInfo(name=f"{inner_dir}/bin/{name}")
            info.size = len(script)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(script))
    return buf.getvalue()


def _ctx(tmp_path: Path, events: list[Event], os_name: str, arch: str) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch=arch,
        os_name=os_name,
        emit=events.append,
    )


def _patch_artifact(
    monkeypatch: pytest.MonkeyPatch, key: tuple[str, str], sha: str
) -> None:
    patched = dict(VALHALLA_TOOLS)
    patched["artifacts"] = dict(VALHALLA_TOOLS["artifacts"])
    filename, _ = patched["artifacts"][key]
    patched["artifacts"][key] = (filename, sha)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.valhalla_tools.VALHALLA_TOOLS", patched
    )


def test_ensure_valhalla_tools_extracts_and_registers_on_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _fake_valhalla_tarball("valhalla-tools-linux-aarch64")
    digest = hashlib.sha256(payload).hexdigest()
    _patch_artifact(monkeypatch, os_arch_key("Linux", "aarch64"), digest)

    def fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        url = getattr(req, "full_url", req)
        return _FakeResponse(payload, url=url)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", fake_urlopen
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Linux", arch="aarch64")
    asyncio.run(ensure_valhalla_tools(ctx))

    build = valhalla_build_tiles_path(ctx)
    service = valhalla_service_path(ctx)
    assert build.exists(), f"{build} missing after extract"
    # Every tarballed CLI gets the exec bit — the service daemon must
    # also be callable so chunk 6's lazy spawn works.
    assert service.exists(), f"{service} missing after extract"
    assert build == tmp_path / "tools" / "valhalla" / "bin" / "valhalla_build_tiles"

    assert "tools/valhalla" in ctx.tools
    path_env = ctx.augmented_env()["PATH"]
    assert str(build.parent) in path_env


def test_ensure_valhalla_tools_skips_when_arch_has_null_spec(
    tmp_path: Path,
) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Windows", arch="x86_64")
    asyncio.run(ensure_valhalla_tools(ctx))

    assert not any(
        "downloading" in getattr(evt, "line", "") for evt in events
    )
    assert not (tmp_path / "tools" / "valhalla").exists()
    assert "tools/valhalla" not in ctx.tools


def test_ensure_valhalla_tools_unknown_arch_skips_cleanly(
    tmp_path: Path,
) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="SunOS", arch="sparc")
    asyncio.run(ensure_valhalla_tools(ctx))
    assert not any(
        "downloading" in getattr(evt, "line", "") for evt in events
    )
