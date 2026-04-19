"""``ensure_temurin_jre`` installs the pinned Temurin runtime.

Exercises both unix ``.tar.gz`` and Windows ``.zip`` layouts using
fabricated vendor archives so the test can assert the extracted tree,
``java -version`` smoke check, and ``PATH`` augmentation without a real
network fetch.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.temurin_jre import ensure_temurin_jre
from lokidoki.bootstrap.versions import TEMURIN_JRE, os_arch_key


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


def _ctx(tmp_path: Path, events: list[Event], os_name: str, arch: str) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch=arch,
        os_name=os_name,
        emit=events.append,
    )


def _fake_temurin_tarball(inner_dir: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        java = b"#!/bin/sh\necho 'openjdk version \"21.0.5\"' 1>&2\n"
        java_info = tarfile.TarInfo(name=f"{inner_dir}/bin/java")
        java_info.size = len(java)
        java_info.mode = 0o644
        tar.addfile(java_info, io.BytesIO(java))

        helper = b"#!/bin/sh\necho helper\n"
        helper_info = tarfile.TarInfo(name=f"{inner_dir}/bin/keytool")
        helper_info.size = len(helper)
        helper_info.mode = 0o644
        tar.addfile(helper_info, io.BytesIO(helper))

        release = b"JAVA_VERSION=\"21.0.5\"\n"
        release_info = tarfile.TarInfo(name=f"{inner_dir}/release")
        release_info.size = len(release)
        tar.addfile(release_info, io.BytesIO(release))
    return buf.getvalue()


def _fake_temurin_mac_bundle(inner_dir: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        java = b"#!/bin/sh\necho 'openjdk version \"21.0.5\"' 1>&2\n"
        java_info = tarfile.TarInfo(name=f"{inner_dir}/Contents/Home/bin/java")
        java_info.size = len(java)
        java_info.mode = 0o644
        tar.addfile(java_info, io.BytesIO(java))

        helper = b"#!/bin/sh\necho helper\n"
        helper_info = tarfile.TarInfo(name=f"{inner_dir}/Contents/Home/bin/keytool")
        helper_info.size = len(helper)
        helper_info.mode = 0o644
        tar.addfile(helper_info, io.BytesIO(helper))

        release = b"JAVA_VERSION=\"21.0.5\"\n"
        release_info = tarfile.TarInfo(name=f"{inner_dir}/Contents/Home/release")
        release_info.size = len(release)
        tar.addfile(release_info, io.BytesIO(release))
    return buf.getvalue()


def _fake_temurin_zip(inner_dir: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr(
            f"{inner_dir}/bin/java.exe",
            "@echo off\r\necho openjdk version \"21.0.5\" 1>&2\r\n",
        )
        zf.writestr(f"{inner_dir}/bin/keytool.exe", "@echo off\r\necho helper\r\n")
        zf.writestr(f"{inner_dir}/release", "JAVA_VERSION=\"21.0.5\"\n")
    return buf.getvalue()


def _patch_download(
    monkeypatch: pytest.MonkeyPatch,
    payload: bytes,
) -> None:
    def _fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        url = getattr(req, "full_url", req)
        return _FakeResponse(payload, url=url)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", _fake_urlopen
    )


@pytest.mark.parametrize(
    ("os_name", "arch"),
    [
        ("Darwin", "arm64"),
        ("Linux", "x86_64"),
        ("Linux", "aarch64"),
    ],
)
def test_ensure_temurin_jre_extracts_tarball_and_patches_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    os_name: str,
    arch: str,
) -> None:
    key = os_arch_key(os_name, arch)
    filename, _ = TEMURIN_JRE["artifacts"][key]
    inner = f"jdk-{TEMURIN_JRE['version']}-jre"
    payload = _fake_temurin_tarball(inner)
    digest = hashlib.sha256(payload).hexdigest()

    patched = dict(TEMURIN_JRE)
    patched["artifacts"] = dict(TEMURIN_JRE["artifacts"])
    patched["artifacts"][key] = (filename, digest)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.TEMURIN_JRE", patched
    )
    _patch_download(monkeypatch, payload)

    seen_cmds: list[list[str]] = []

    def _fake_run(cmd, *args, **kwargs):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout="",
            stderr='openjdk version "21.0.5" 2024-10-15 LTS\n',
        )

    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.subprocess.run", _fake_run
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name=os_name, arch=arch)
    asyncio.run(ensure_temurin_jre(ctx))

    java_bin = tmp_path / "tools" / "jre" / "bin" / "java"
    assert java_bin.exists()
    assert (tmp_path / "tools" / "jre" / "release").exists()
    assert ctx.binary_path("java") == java_bin
    assert "tools/jre" in ctx.tools
    assert str(tmp_path / "tools" / "jre" / "bin") in ctx.augmented_env()["PATH"]
    assert seen_cmds == [[str(java_bin), "-version"]]


def test_ensure_temurin_jre_flattens_macos_contents_home(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = os_arch_key("Darwin", "arm64")
    filename, _ = TEMURIN_JRE["artifacts"][key]
    inner = f"jdk-{TEMURIN_JRE['version']}-jre"
    payload = _fake_temurin_mac_bundle(inner)
    digest = hashlib.sha256(payload).hexdigest()

    patched = dict(TEMURIN_JRE)
    patched["artifacts"] = dict(TEMURIN_JRE["artifacts"])
    patched["artifacts"][key] = (filename, digest)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.TEMURIN_JRE", patched
    )
    _patch_download(monkeypatch, payload)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.subprocess.run",
        lambda cmd, *args, **kwargs: subprocess.CompletedProcess(  # noqa: ARG005, ANN001
            cmd, 0, stdout="", stderr='openjdk version "21.0.5" 2024-10-15 LTS\n'
        ),
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Darwin", arch="arm64")
    asyncio.run(ensure_temurin_jre(ctx))

    assert (tmp_path / "tools" / "jre" / "bin" / "java").exists()
    assert (tmp_path / "tools" / "jre" / "release").exists()


def test_ensure_temurin_jre_extracts_windows_zip(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = os_arch_key("Windows", "x86_64")
    filename, _ = TEMURIN_JRE["artifacts"][key]
    inner = f"jdk-{TEMURIN_JRE['version']}-jre"
    payload = _fake_temurin_zip(inner)
    digest = hashlib.sha256(payload).hexdigest()

    patched = dict(TEMURIN_JRE)
    patched["artifacts"] = dict(TEMURIN_JRE["artifacts"])
    patched["artifacts"][key] = (filename, digest)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.TEMURIN_JRE", patched
    )
    _patch_download(monkeypatch, payload)

    seen_cmds: list[list[str]] = []

    def _fake_run(cmd, *args, **kwargs):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout="",
            stderr='openjdk version "21.0.5" 2024-10-15 LTS\r\n',
        )

    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.temurin_jre.subprocess.run", _fake_run
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Windows", arch="x86_64")
    asyncio.run(ensure_temurin_jre(ctx))

    java_bin = tmp_path / "tools" / "jre" / "bin" / "java.exe"
    assert java_bin.exists()
    assert ctx.binary_path("java") == java_bin
    assert "tools/jre" in ctx.tools
    assert str(tmp_path / "tools" / "jre") in ctx.augmented_env()["PATH"]
    assert seen_cmds == [[str(java_bin), "-version"]]


def test_ensure_temurin_jre_missing_artifact_raises(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="SunOS", arch="sparc")
    with pytest.raises(RuntimeError, match="no temurin jre artifact pinned"):
        asyncio.run(ensure_temurin_jre(ctx))
