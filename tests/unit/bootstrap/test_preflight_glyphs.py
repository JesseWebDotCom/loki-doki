"""``ensure_glyphs`` downloads basemaps-assets and extracts glyph PBFs.

Builds a fake tarball in-process that matches the upstream archive
layout so the test never touches the network. Asserts SHA-256
verification fires, the required Noto Sans fontstacks survive
extraction, and the bootstrap-visible path is registered via
``ctx.binary_path``.
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
from lokidoki.bootstrap.preflight.glyphs import ensure_glyphs
from lokidoki.bootstrap.versions import GLYPHS_ASSETS


_INNER = "basemaps-assets-deadbeef"
_STACKS = ("Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic")


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def _fake_tarball() -> bytes:
    """Tarball with glyph PBFs plus unrelated files that must be filtered out."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for stack in _STACKS:
            for rng in ("0-255", "256-511", "65280-65535"):
                payload = f"{stack}-{rng}".encode("utf-8") + b"\x00" * 16
                info = tarfile.TarInfo(name=f"{_INNER}/fonts/{stack}/{rng}.pbf")
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))
        # A non-PBF file in the right fontstack dir — must be ignored.
        readme = b"ignored"
        readme_info = tarfile.TarInfo(
            name=f"{_INNER}/fonts/Noto Sans Regular/README.md"
        )
        readme_info.size = len(readme)
        tar.addfile(readme_info, io.BytesIO(readme))
        # Sprites / icons outside fonts/ — must be ignored.
        sprite = b"sprite-bytes"
        sprite_info = tarfile.TarInfo(name=f"{_INNER}/sprites/icons.png")
        sprite_info.size = len(sprite)
        tar.addfile(sprite_info, io.BytesIO(sprite))
    return buf.getvalue()


def _patch_pin(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    digest = hashlib.sha256(payload).hexdigest()
    patched = dict(GLYPHS_ASSETS)
    patched["sha256"] = digest
    monkeypatch.setattr(
        "lokidoki.bootstrap.preflight.glyphs.GLYPHS_ASSETS", patched
    )


def test_ensure_glyphs_downloads_and_extracts_required_fontstacks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _fake_tarball()
    _patch_pin(monkeypatch, payload)

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_glyphs(ctx))

    glyphs_root = tmp_path / "tools" / "glyphs"
    assert ctx.binary_path("glyphs") == glyphs_root

    for stack in _STACKS:
        noto_dir = glyphs_root / stack
        assert noto_dir.is_dir()
        pbfs = sorted(p.name for p in noto_dir.iterdir())
        assert pbfs == ["0-255.pbf", "256-511.pbf", "65280-65535.pbf"]
        assert (noto_dir / "0-255.pbf").stat().st_size > 0

    # The sprites subtree must not leak in.
    assert not (glyphs_root / "sprites").exists()
    assert not (glyphs_root / "Noto Sans Regular" / "README.md").exists()

    # Exactly one download happened, with the pinned sha256.
    assert len(download_calls) == 1
    url, dest, step_id, sha = download_calls[0]
    assert url == GLYPHS_ASSETS["url_template"].format(commit=GLYPHS_ASSETS["commit"])
    assert dest == tmp_path / "cache" / GLYPHS_ASSETS["filename"]
    assert step_id == "install-glyphs"
    assert sha == hashlib.sha256(payload).hexdigest()


def test_ensure_glyphs_skips_when_already_installed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pre-populate the install dir so the preflight short-circuits.
    for stack in _STACKS:
        noto_dir = tmp_path / "tools" / "glyphs" / stack
        noto_dir.mkdir(parents=True, exist_ok=True)
        (noto_dir / "0-255.pbf").write_bytes(b"\x00\x01\x02\x03")

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_glyphs(ctx))

    assert download_calls == []


def test_ensure_glyphs_fails_when_archive_missing_fontstack(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Tarball contains zero required fontstack entries — preflight must
    # refuse to silently install an incomplete glyph tree.
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        payload = b"no-fonts"
        info = tarfile.TarInfo(name=f"{_INNER}/README.md")
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    bad = buf.getvalue()
    _patch_pin(monkeypatch, bad)

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(bad)

    monkeypatch.setattr(StepContext, "download", _fake_download)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="Noto Sans Italic"):
        asyncio.run(ensure_glyphs(ctx))
