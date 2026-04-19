"""``ensure_tippecanoe`` end-to-end against a fabricated tippecanoe tarball.

Follows ``test_preflight_node`` — forges a ``.tar.gz`` shaped like the
maps-tools-v1 release asset, pipes it through the stdlib urlopen shim,
and asserts the binary lands under ``.lokidoki/tools/tippecanoe/bin/``
and that the bin dir gets registered on the :class:`StepContext` tools
tuple (so ``augmented_env()[\"PATH\"]`` picks it up for downstream
subprocess calls).
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
from lokidoki.bootstrap.preflight.tippecanoe import (
    ensure_tippecanoe,
    tippecanoe_path,
)
from lokidoki.bootstrap.versions import TIPPECANOE, os_arch_key


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


def _fake_tippecanoe_tarball(inner_dir: str) -> bytes:
    """Build a minimal gz tarball carrying ``bin/tippecanoe`` + a README."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        script = b"#!/bin/sh\necho tippecanoe v9.9-test\n"
        info = tarfile.TarInfo(name=f"{inner_dir}/bin/tippecanoe")
        info.size = len(script)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(script))
        readme = b"tippecanoe test fixture\n"
        info2 = tarfile.TarInfo(name=f"{inner_dir}/README.md")
        info2.size = len(readme)
        tar.addfile(info2, io.BytesIO(readme))
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
    patched = dict(TIPPECANOE)
    patched["artifacts"] = dict(TIPPECANOE["artifacts"])
    filename, _ = patched["artifacts"][key]
    patched["artifacts"][key] = (filename, sha)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.tippecanoe.TIPPECANOE", patched
    )


def test_ensure_tippecanoe_extracts_and_registers_on_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _fake_tippecanoe_tarball("tippecanoe-darwin-arm64")
    digest = hashlib.sha256(payload).hexdigest()
    _patch_artifact(monkeypatch, os_arch_key("Darwin", "arm64"), digest)

    def fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        url = getattr(req, "full_url", req)
        return _FakeResponse(payload, url=url)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", fake_urlopen
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Darwin", arch="arm64")
    asyncio.run(ensure_tippecanoe(ctx))

    binary = tippecanoe_path(ctx)
    assert binary.exists(), f"{binary} missing after extract"
    assert binary.is_file()
    # Preflight ran flatten on the wrapper dir so the layout mirrors the
    # other bootstrap tools: ``<data>/tools/tippecanoe/bin/tippecanoe``.
    assert binary == tmp_path / "tools" / "tippecanoe" / "bin" / "tippecanoe"

    # Registered on ``ctx.tools`` so augmented_env() prepends the bin dir to PATH.
    assert "tools/tippecanoe" in ctx.tools
    path_env = ctx.augmented_env()["PATH"]
    assert str(binary.parent) in path_env


def test_ensure_tippecanoe_skips_when_arch_has_null_spec(
    tmp_path: Path,
) -> None:
    """Windows is pinned to ``None`` until an upstream static build exists —
    the preflight must log + skip, not download or raise."""
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Windows", arch="x86_64")
    asyncio.run(ensure_tippecanoe(ctx))

    # No download was attempted.
    assert not any(
        "downloading" in getattr(evt, "line", "") for evt in events
    )
    # No binary was written.
    assert not (tmp_path / "tools" / "tippecanoe").exists()
    # Path not registered either.
    assert "tools/tippecanoe" not in ctx.tools


def test_ensure_tippecanoe_unknown_arch_skips_cleanly(
    tmp_path: Path,
) -> None:
    """Unknown (os, arch) keys skip without raising — maps is optional."""
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="SunOS", arch="sparc")
    asyncio.run(ensure_tippecanoe(ctx))
    assert not any(
        "downloading" in getattr(evt, "line", "") for evt in events
    )
