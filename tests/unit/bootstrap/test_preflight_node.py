"""``ensure_node`` end-to-end against a fabricated node tarball.

We forge a tarball shaped like the vendor archive
(``node-v<ver>-<os>-<arch>/bin/node``), pipe it through the same
urlopen shim the integrity test uses, and assert that after
``ensure_node`` runs the embedded binary lives where
:meth:`StepContext.binary_path` expects it.
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
from lokidoki.bootstrap.preflight.node_runtime import ensure_node
from lokidoki.bootstrap.versions import NODE, os_arch_key


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


def _fake_node_tarball(inner_dir: str) -> bytes:
    """Build a minimal gz tarball with the vendor's layout."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        script = b"#!/bin/sh\necho v" + NODE["version"].encode() + b"\n"
        info = tarfile.TarInfo(name=f"{inner_dir}/bin/node")
        info.size = len(script)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(script))
        readme = b"vendor readme\n"
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


def test_ensure_node_extracts_and_flattens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inner = f"node-v{NODE['version']}-darwin-arm64"
    payload = _fake_node_tarball(inner)
    digest = hashlib.sha256(payload).hexdigest()

    patched = dict(NODE)
    patched["artifacts"] = dict(NODE["artifacts"])
    key = os_arch_key("Darwin", "arm64")
    filename, _ = patched["artifacts"][key]
    patched["artifacts"][key] = (filename, digest)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.node_runtime.NODE", patched
    )

    def _fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        url = getattr(req, "full_url", req)
        return _FakeResponse(payload, url=url)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", _fake_urlopen
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Darwin", arch="arm64")
    asyncio.run(ensure_node(ctx))

    node_bin = tmp_path / "node" / "bin" / "node"
    assert node_bin.exists(), f"{node_bin} not created"
    assert node_bin.is_file()


def test_ensure_node_missing_artifact_raises(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="SunOS", arch="sparc")
    with pytest.raises(RuntimeError, match="no node artifact pinned"):
        asyncio.run(ensure_node(ctx))
