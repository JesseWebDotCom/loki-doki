"""Install the embedded Node.js runtime into ``.lokidoki/node/``.

Unix tarballs (``.tar.gz`` on darwin, ``.tar.xz`` on linux) nest the
toolchain under ``node-v<ver>-<os>-<arch>/``; we flatten one level so
the layout matches :meth:`StepContext.binary_path` / ``_tool_bin_dir``
— ``.lokidoki/node/bin/node`` on unix. The Windows zip extracts with
``node.exe`` at its root so we drop the single inner directory on top
of ``.lokidoki/node/`` instead.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import NODE, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "embed-node"


async def ensure_node(ctx: StepContext) -> None:
    """Download + extract Node.js into ``.lokidoki/node/`` if missing."""
    node_bin = ctx.binary_path("node")
    expected_version = NODE["version"]

    if node_bin.exists() and _reports_version(node_bin, expected_version):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"embedded node {expected_version} already present",
            )
        )
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = NODE["artifacts"]
    if key not in artifacts:
        raise RuntimeError(f"no node artifact pinned for os/arch={key}")
    filename, sha256 = artifacts[key]
    url = NODE["url_template"].format(version=expected_version, filename=filename)

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / "node"
    is_zip = filename.endswith(".zip")
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target, is_zip=is_zip)

    if not node_bin.exists():
        raise RuntimeError(
            f"extraction completed but {node_bin} is missing — archive layout changed?"
        )
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"embedded node ready at {node_bin}"))


def _reports_version(node_bin: Path, expected: str) -> bool:
    try:
        out = subprocess.run(
            [str(node_bin), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    probe = (out.stdout + out.stderr).strip()
    return probe == f"v{expected}"


def _extract(archive: Path, target: Path, *, is_zip: bool) -> None:
    """Extract ``archive`` into ``target`` — always flattens the vendor's
    top-level ``node-v<ver>-<os>-<arch>/`` dir."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-node-") as tmp:
        tmp_path = Path(tmp)
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp_path)
        else:
            mode = "r:xz" if archive.suffix == ".xz" else "r:gz"
            with tarfile.open(archive, mode) as tar:
                tar.extractall(tmp_path)
        inner = _locate_inner_dir(tmp_path)
        for item in inner.iterdir():
            shutil.move(str(item), str(target / item.name))


def _locate_inner_dir(tmp_path: Path) -> Path:
    dirs = [e for e in tmp_path.iterdir() if e.is_dir()]
    if len(dirs) == 1 and dirs[0].name.startswith("node-"):
        return dirs[0]
    raise RuntimeError(
        f"unexpected node archive layout: {[e.name for e in tmp_path.iterdir()]}"
    )
