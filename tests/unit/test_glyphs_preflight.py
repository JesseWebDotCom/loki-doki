"""Unit tests for multi-fontstack glyph preflight extraction."""
from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from lokidoki.bootstrap.preflight.glyphs import _extract_glyphs


_INNER = "basemaps-assets-deadbeef"
_STACKS = ("Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic")


def _tarball_bytes(stacks: tuple[str, ...]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for stack in stacks:
            payload = f"{stack}-0-255".encode("utf-8")
            info = tarfile.TarInfo(name=f"{_INNER}/fonts/{stack}/0-255.pbf")
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


def _write_tarball(path: Path, stacks: tuple[str, ...]) -> Path:
    path.write_bytes(_tarball_bytes(stacks))
    return path


def test_extracts_all_three_fontstacks(tmp_path: Path) -> None:
    archive = _write_tarball(tmp_path / "glyphs.tar.gz", _STACKS)

    count = _extract_glyphs(archive, tmp_path / "glyphs")

    assert count == 3
    for stack in _STACKS:
        glyph = tmp_path / "glyphs" / stack / "0-255.pbf"
        assert glyph.is_file(), stack
        assert glyph.read_bytes() == f"{stack}-0-255".encode("utf-8")


def test_raises_when_required_stack_missing_from_archive(tmp_path: Path) -> None:
    archive = _write_tarball(
        tmp_path / "glyphs.tar.gz",
        ("Noto Sans Regular", "Noto Sans Medium"),
    )

    with pytest.raises(RuntimeError, match="Noto Sans Italic"):
        _extract_glyphs(archive, tmp_path / "glyphs")
