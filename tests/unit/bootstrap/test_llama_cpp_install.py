"""``ensure_llama_cpp`` end-to-end against a fabricated llama.cpp tarball.

We forge a tar.gz shaped like the real linux release (single inner
``llama-<ver>/`` dir carrying ``llama-server`` + shared libs), pipe it
through the same urlopen shim ``test_download_integrity`` uses, and
assert the binary lands at :meth:`llama_server_path`.
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
from lokidoki.bootstrap.preflight.llama_cpp_runtime import (
    ensure_llama_cpp,
    llama_server_path,
)
from lokidoki.bootstrap.versions import LLAMA_CPP, os_arch_key


class _FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._stream = io.BytesIO(data)
        self.headers = {"Content-Length": str(len(data))}
        self.url = "https://github.invalid/llama.tar.gz"
        self.status = 200

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> None:
        self._stream.close()

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


def _fake_linux_tarball(version: str, arch_tag: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        inner = f"llama-{version}"
        server = b"#!/bin/sh\necho llama-server stub\n"
        info = tarfile.TarInfo(name=f"{inner}/llama-server")
        info.size = len(server)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(server))
        lib = b"fake libggml payload"
        info2 = tarfile.TarInfo(name=f"{inner}/libggml-base.so")
        info2.size = len(lib)
        info2.mode = 0o644
        tar.addfile(info2, io.BytesIO(lib))
    return buf.getvalue()


def _ctx(tmp_path: Path, events: list[Event], os_name: str, arch: str, profile: str) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile=profile,
        arch=arch,
        os_name=os_name,
        emit=events.append,
    )


def _patch_artifact(monkeypatch: pytest.MonkeyPatch, key: tuple[str, str], payload: bytes) -> None:
    """Swap the pinned sha256 for the synthesized tarball's sha."""
    patched = dict(LLAMA_CPP)
    patched["artifacts"] = dict(LLAMA_CPP["artifacts"])
    filename, _ = patched["artifacts"][key]
    digest = hashlib.sha256(payload).hexdigest()
    patched["artifacts"][key] = (filename, digest)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.llama_cpp_runtime.LLAMA_CPP", patched
    )


def test_ensure_llama_cpp_extracts_aarch64_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _fake_linux_tarball(LLAMA_CPP["version"], "aarch64")
    _patch_artifact(monkeypatch, os_arch_key("Linux", "aarch64"), payload)

    def fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        return _FakeResponse(payload)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", fake_urlopen
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Linux", arch="aarch64", profile="pi_cpu")
    asyncio.run(ensure_llama_cpp(ctx))

    binary = llama_server_path(ctx)
    assert binary.exists(), f"{binary} missing after extract"
    # Shared libs must also be copied so llama-server can dlopen them.
    assert (binary.parent / "libggml-base.so").exists()


def test_pi_cpu_rejects_vulkan_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard — pi_cpu must not pull a Vulkan release."""
    patched = dict(LLAMA_CPP)
    patched["artifacts"] = dict(LLAMA_CPP["artifacts"])
    key = os_arch_key("Linux", "aarch64")
    patched["artifacts"][key] = (
        "llama-b8797-bin-ubuntu-vulkan-arm64.tar.gz",
        "0" * 64,
    )
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.llama_cpp_runtime.LLAMA_CPP", patched
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Linux", arch="aarch64", profile="pi_cpu")
    with pytest.raises(RuntimeError, match="CPU/NEON"):
        asyncio.run(ensure_llama_cpp(ctx))


def test_missing_artifact_key_raises(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Darwin", arch="arm64", profile="mac")
    with pytest.raises(RuntimeError, match="no llama.cpp artifact"):
        asyncio.run(ensure_llama_cpp(ctx))
