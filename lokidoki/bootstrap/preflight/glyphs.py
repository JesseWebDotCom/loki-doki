"""Install Protomaps basemaps-assets glyph PBFs under ``.lokidoki/tools/glyphs/``.

Extracts the required ``Noto Sans`` fontstacks from the upstream tarball
and discards the rest of the archive (sprites, icons, alternate stacks).
"""
from __future__ import annotations

import logging
import shutil
import tarfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import GLYPHS_ASSETS


_log = logging.getLogger(__name__)
_STEP_ID = "install-glyphs"
_FONTSTACKS: tuple[str, ...] = (
    "Noto Sans Regular",
    "Noto Sans Bold",
    "Noto Sans Italic",
)


async def ensure_glyphs(ctx: StepContext) -> None:
    """Download the pinned basemaps-assets tarball and extract glyph PBFs."""
    target = ctx.binary_path("glyphs")
    if not _missing_fontstacks(target):
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"glyphs already present at {target}")
        )
        return

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / GLYPHS_ASSETS["filename"]
    url = GLYPHS_ASSETS["url_template"].format(commit=GLYPHS_ASSETS["commit"])

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=GLYPHS_ASSETS["sha256"])

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting glyphs into {target}"))
    count = _extract_glyphs(archive, target)
    if count == 0:
        raise RuntimeError(
            f"no glyph PBFs extracted from {archive} — archive layout changed?"
        )
    missing = _missing_fontstacks(target)
    if missing:
        missing_names = ", ".join(missing)
        raise RuntimeError(
            "extraction completed but required glyph PBFs are missing or empty: "
            f"{missing_names}"
        )
    ctx.emit(
        StepLog(step_id=_STEP_ID, line=f"installed {count} glyph PBFs at {target}")
    )


def _extract_glyphs(archive: Path, target: Path) -> int:
    """Extract ``fonts/<fontstack>/*.pbf`` into ``<target>/<fontstack>/``."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    count = 0
    for stack in _FONTSTACKS:
        dest = target / stack
        dest.mkdir(parents=True, exist_ok=True)
        count += _extract_fontstack(archive, stack, dest)
    missing = _missing_fontstacks(target)
    if missing:
        missing_names = ", ".join(missing)
        raise RuntimeError(
            f"archive {archive} is missing required glyph fontstacks: {missing_names}"
        )
    _log.info("extracted %d glyph PBFs into %s", count, target)
    return count


def _extract_fontstack(archive: Path, stack: str, dest: Path) -> int:
    """Extract all PBF files for one fontstack."""
    needle = f"fonts/{stack}/"
    count = 0
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile() or needle not in member.name:
                continue
            basename = Path(member.name).name
            if not basename.endswith(".pbf"):
                continue
            src = tar.extractfile(member)
            if src is None:
                continue
            (dest / basename).write_bytes(src.read())
            count += 1
    return count


def _missing_fontstacks(target: Path) -> list[str]:
    """Return required fontstacks whose primary range file is absent or empty."""
    missing: list[str] = []
    for stack in _FONTSTACKS:
        first_pbf = target / stack / "0-255.pbf"
        if not first_pbf.exists() or first_pbf.stat().st_size == 0:
            missing.append(stack)
    return missing
