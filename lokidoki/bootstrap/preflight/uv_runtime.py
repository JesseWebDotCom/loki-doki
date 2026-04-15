"""Install the pinned ``uv`` binary into ``.lokidoki/uv/``.

Unix archives are ``.tar.gz``; Windows ships a ``.zip``. Binaries land
where :meth:`StepContext.binary_path` expects them — ``bin/uv`` on unix,
``uv.exe`` at the root on Windows.
"""
from __future__ import annotations

import logging
import os
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import UV, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "install-uv"


async def ensure_uv(ctx: StepContext) -> None:
    """Download + extract ``uv`` into ``.lokidoki/uv/`` if not already present."""
    uv_bin = ctx.binary_path("uv")
    if uv_bin.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"uv already present at {uv_bin}"))
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = UV["artifacts"]
    if key not in artifacts:
        raise RuntimeError(f"no uv artifact pinned for os/arch={key}")
    filename, sha256 = artifacts[key]
    url = UV["url_template"].format(version=UV["version"], filename=filename)

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / "uv"
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target, is_zip=filename.endswith(".zip"))

    if not uv_bin.exists():
        raise RuntimeError(
            f"extraction completed but {uv_bin} is missing — archive layout changed?"
        )
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"uv ready at {uv_bin}"))


def _extract(archive: Path, target: Path, *, is_zip: bool) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-uv-") as tmp:
        tmp_path = Path(tmp)
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp_path)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(tmp_path)
        source = _locate_uv_source(tmp_path)
        if is_zip:
            # Windows: drop uv.exe (and friends) into target/ directly.
            for item in source.iterdir():
                shutil.move(str(item), str(target / item.name))
        else:
            bin_dir = target / "bin"
            bin_dir.mkdir(parents=True, exist_ok=True)
            for name in ("uv", "uvx"):
                src = source / name
                if src.exists():
                    dest = bin_dir / name
                    shutil.move(str(src), str(dest))
                    _make_executable(dest)


def _locate_uv_source(tmp_path: Path) -> Path:
    """Return the directory inside the extracted archive that holds ``uv``."""
    for candidate in ("uv", "uv.exe"):
        if (tmp_path / candidate).exists():
            return tmp_path
    dirs = [e for e in tmp_path.iterdir() if e.is_dir()]
    if len(dirs) == 1:
        inner = dirs[0]
        if (inner / "uv").exists() or (inner / "uv.exe").exists():
            return inner
    raise RuntimeError(
        f"could not locate uv binary inside extracted archive: {list(tmp_path.iterdir())}"
    )


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
