"""Install Protomaps basemaps-assets glyph PBFs under ``.lokidoki/tools/glyphs/``.

Extracts only the ``fonts/Noto Sans Regular/*.pbf`` range files from the
upstream tarball — the rest of the archive (sprites, icons, alternate
font stacks) is discarded. The MapLibre style in
``frontend/src/pages/maps/style-dark.ts`` references ``Noto Sans Regular``
exclusively, so that single fontstack covers every text layer we render.
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
_FONTSTACK = "Noto Sans Regular"


async def ensure_glyphs(ctx: StepContext) -> None:
    """Download the pinned basemaps-assets tarball and extract glyph PBFs."""
    target = ctx.binary_path("glyphs")
    first_pbf = target / _FONTSTACK / "0-255.pbf"
    if first_pbf.exists() and first_pbf.stat().st_size > 0:
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
    if not first_pbf.exists() or first_pbf.stat().st_size == 0:
        raise RuntimeError(
            f"extraction completed but {first_pbf} is missing or empty"
        )
    ctx.emit(
        StepLog(step_id=_STEP_ID, line=f"installed {count} glyph PBFs at {target}")
    )


def _extract_glyphs(archive: Path, target: Path) -> int:
    """Extract ``fonts/<fontstack>/*.pbf`` into ``<target>/<fontstack>/``.

    Returns the number of PBF files written.
    """
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    dest = target / _FONTSTACK
    dest.mkdir(parents=True, exist_ok=True)

    needle = f"fonts/{_FONTSTACK}/"
    count = 0
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            if needle not in member.name:
                continue
            basename = Path(member.name).name
            if not basename.endswith(".pbf"):
                continue
            src = tar.extractfile(member)
            if src is None:
                continue
            (dest / basename).write_bytes(src.read())
            count += 1
    _log.info("extracted %d glyph PBFs into %s", count, dest)
    return count
