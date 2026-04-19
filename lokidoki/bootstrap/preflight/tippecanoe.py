"""Install the pinned tippecanoe CLI into ``.lokidoki/tools/tippecanoe/``.

Tippecanoe compiles Geofabrik PBF extracts into the PMTiles vector
basemap the maps page renders. Chunk 3 shells out to this binary per
region install — no remote CDN for prebuilt tiles — so the bootstrap
has to guarantee it's on disk for every maps-enabled profile.

Archives ship as assets on the ``maps-tools-v1`` GitHub Release on the
loki-doki repo (see :data:`TIPPECANOE`). Windows is pinned to ``None``
until an upstream static build exists; on that key the preflight
no-ops with an informative log line so the rest of the install still
completes and the maps UI renders the unsupported-host state.
"""
from __future__ import annotations

import logging
import shutil
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import TIPPECANOE, os_arch_key


_STEP_ID = "install-tippecanoe"
_TOOL_REL = "tools/tippecanoe"
_log = logging.getLogger(__name__)


def tippecanoe_path(ctx: StepContext) -> Path:
    """Expected on-disk path of the tippecanoe binary."""
    exe = "tippecanoe.exe" if ctx.os_name == "Windows" else "tippecanoe"
    return ctx.data_dir / _TOOL_REL / "bin" / exe


async def ensure_tippecanoe(ctx: StepContext) -> None:
    """Download + extract tippecanoe into ``.lokidoki/tools/tippecanoe/``."""
    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = TIPPECANOE["artifacts"]
    if key not in artifacts:
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"tippecanoe: no pinned artifact for os/arch={key} — "
                    "maps install is unsupported on this host."
                ),
            )
        )
        return
    spec = artifacts[key]
    if spec is None:
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"tippecanoe: explicitly unsupported on {key} "
                    "(no upstream static build). Skipping; maps install "
                    "will fail on this host until an artifact is pinned."
                ),
            )
        )
        return

    filename, sha256 = spec
    binary = tippecanoe_path(ctx)

    if binary.exists() and _smoke_ok(binary):
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"tippecanoe already present at {binary}")
        )
        _register_on_path(ctx)
        return

    url = TIPPECANOE["url_template"].format(
        version=TIPPECANOE["version"], filename=filename
    )
    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / _TOOL_REL
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target)

    if not binary.exists():
        raise RuntimeError(
            f"extraction completed but {binary} is missing — archive layout changed?"
        )
    if ctx.os_name != "Windows":
        _make_executable(binary)
    if not _smoke_ok(binary):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"warning: {binary} --version smoke test did not return "
                    "a version string — continuing anyway"
                ),
            )
        )
    _register_on_path(ctx)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"tippecanoe ready at {binary}"))


def _smoke_ok(binary: Path) -> bool:
    """Best-effort ``--version`` probe. Returns True on any non-empty output."""
    try:
        out = subprocess.run(
            [str(binary), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool((out.stdout + out.stderr).strip())


def _extract(archive: Path, target: Path) -> None:
    """Extract ``archive`` into ``target``, flattening a single wrapper dir."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-tippecanoe-") as tmp:
        tmp_path = Path(tmp)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(tmp_path)
        source = _flatten_wrapper(tmp_path)
        for item in source.iterdir():
            shutil.move(str(item), str(target / item.name))


def _flatten_wrapper(tmp_path: Path) -> Path:
    entries = list(tmp_path.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return tmp_path


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _register_on_path(ctx: StepContext) -> None:
    """Append ``tools/tippecanoe`` to ``ctx.tools`` so :meth:`StepContext.augmented_env`
    prepends the bin dir to ``PATH`` for downstream subprocess calls
    (per-region install in chunk 3). Idempotent."""
    if _TOOL_REL in ctx.tools:
        return
    ctx.tools = tuple(list(ctx.tools) + [_TOOL_REL])
