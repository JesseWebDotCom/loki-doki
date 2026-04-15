"""Install the embedded python-build-standalone interpreter.

Skip if ``.lokidoki/python/bin/python3`` already reports a matching
version; otherwise download the pinned tarball (SHA-256 verified),
extract it, and drop the payload into ``.lokidoki/python/`` after
stripping the vendor tarball's top-level ``python/`` directory.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import PYTHON_BUILD_STANDALONE, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "embed-python"


async def ensure_embedded_python(ctx: StepContext) -> None:
    """Download + extract python-build-standalone into ``.lokidoki/python/``."""
    target = ctx.data_dir / "python"
    py_bin = ctx.binary_path("python")
    expected_version = PYTHON_BUILD_STANDALONE["version"]

    if py_bin.exists() and _reports_version(py_bin, expected_version):
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"embedded python {expected_version} already present")
        )
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = PYTHON_BUILD_STANDALONE["artifacts"]
    if key not in artifacts:
        raise RuntimeError(
            f"no python-build-standalone artifact pinned for os/arch={key}"
        )
    filename, sha256 = artifacts[key]
    url = PYTHON_BUILD_STANDALONE["url_template"].format(
        tag=PYTHON_BUILD_STANDALONE["tag"], filename=filename
    )

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target)

    if not py_bin.exists():
        raise RuntimeError(
            f"extraction completed but {py_bin} is missing — archive layout changed?"
        )
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"embedded python ready at {py_bin}"))


def _reports_version(py_bin: Path, expected: str) -> bool:
    try:
        out = subprocess.run(
            [str(py_bin), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    probe = (out.stdout + out.stderr).strip()
    return probe.startswith(f"Python {expected}")


def _extract(archive: Path, target: Path) -> None:
    """Extract ``archive`` into ``target`` — strips the top-level ``python/`` dir."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-pbs-") as tmp:
        tmp_path = Path(tmp)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(tmp_path)
        inner = tmp_path / "python"
        if not inner.is_dir():
            entries = [e for e in tmp_path.iterdir() if e.is_dir()]
            if len(entries) != 1:
                raise RuntimeError(
                    f"unexpected tarball layout in {archive}: {[e.name for e in tmp_path.iterdir()]}"
                )
            inner = entries[0]
        for item in inner.iterdir():
            shutil.move(str(item), str(target / item.name))
