"""``ensure_planetiler`` downloads the pinned planetiler JAR and smoke tests it."""
from __future__ import annotations

import asyncio
import hashlib
import subprocess
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.planetiler import ensure_planetiler
from lokidoki.bootstrap.versions import PLANETILER


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def test_ensure_planetiler_downloads_and_smoke_tests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    java_bin = tmp_path / "tools" / "jre" / "bin" / "java"
    java_bin.parent.mkdir(parents=True, exist_ok=True)
    java_bin.write_text("#!/bin/sh\nexit 0\n")
    java_bin.chmod(0o755)

    payload = b"fake-planetiler-jar"
    digest = hashlib.sha256(payload).hexdigest()
    patched = dict(PLANETILER)
    patched["sha256"] = digest
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.planetiler.PLANETILER", patched
    )

    download_calls: list[tuple[str, Path, str, str | None]] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    seen_cmds: list[list[str]] = []

    def _fake_run(cmd, *args, **kwargs):  # noqa: ANN001
        seen_cmds.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, stdout="planetiler help\n", stderr="")

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.planetiler.subprocess.run", _fake_run
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_planetiler(ctx))

    jar_path = tmp_path / "tools" / "planetiler" / "planetiler.jar"
    assert jar_path.exists()
    assert ctx.binary_path("planetiler_jar") == jar_path
    assert download_calls == [(
        PLANETILER["url_template"].format(version=PLANETILER["version"]),
        jar_path,
        "install-planetiler",
        digest,
    )]
    assert seen_cmds == [[str(tmp_path / "tools" / "jre" / "bin" / "java"), "-jar", str(jar_path), "--help"]]


def test_ensure_planetiler_reuses_existing_jar(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    java_bin = tmp_path / "tools" / "jre" / "bin" / "java"
    java_bin.parent.mkdir(parents=True, exist_ok=True)
    java_bin.write_text("#!/bin/sh\nexit 0\n")
    java_bin.chmod(0o755)

    jar_path = tmp_path / "tools" / "planetiler" / "planetiler.jar"
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    jar_path.write_bytes(b"already-there")

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))

    monkeypatch.setattr(StepContext, "download", _fake_download)
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.planetiler._smoke_ok",
        lambda java_bin, jar: True,
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_planetiler(ctx))

    assert download_calls == []
