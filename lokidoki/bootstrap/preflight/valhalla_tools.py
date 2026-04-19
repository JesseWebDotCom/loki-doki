"""Install the pinned Valhalla build CLIs + ``valhalla_service`` daemon.

The tarball carries the full Valhalla build toolchain:
``valhalla_build_tiles``, ``valhalla_build_admins``,
``valhalla_build_elevations``, plus the ``valhalla_service`` daemon
chunk 6 spawns lazily for routing queries. Chunk 3 consumes the
``valhalla_build_*`` CLIs during per-region install — no remote CDN
for prebuilt routing graphs — so the bootstrap guarantees them on
disk for every maps-enabled profile.

Archives ship as assets on the ``maps-tools-v1`` GitHub Release (see
:data:`VALHALLA_TOOLS`). Windows is pinned to ``None`` until a
reliable static build exists; the preflight no-ops with a clear log
line on that key.
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
from ..versions import VALHALLA_TOOLS, os_arch_key


_STEP_ID = "install-valhalla-tools"
_TOOL_REL = "tools/valhalla"
_log = logging.getLogger(__name__)


def valhalla_build_tiles_path(ctx: StepContext) -> Path:
    """Expected on-disk path of the ``valhalla_build_tiles`` CLI."""
    exe = "valhalla_build_tiles.exe" if ctx.os_name == "Windows" else "valhalla_build_tiles"
    return ctx.data_dir / _TOOL_REL / "bin" / exe


def valhalla_service_path(ctx: StepContext) -> Path:
    """Expected on-disk path of the ``valhalla_service`` routing daemon."""
    exe = "valhalla_service.exe" if ctx.os_name == "Windows" else "valhalla_service"
    return ctx.data_dir / _TOOL_REL / "bin" / exe


async def ensure_valhalla_tools(ctx: StepContext) -> None:
    """Download + extract the Valhalla tools tarball into ``.lokidoki/tools/valhalla/``."""
    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = VALHALLA_TOOLS["artifacts"]
    if key not in artifacts:
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"valhalla-tools: no pinned artifact for os/arch={key} — "
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
                    f"valhalla-tools: explicitly unsupported on {key} "
                    "(no upstream static build). Skipping; maps install "
                    "will fail on this host until an artifact is pinned."
                ),
            )
        )
        return

    filename, sha256 = spec
    build_tiles = valhalla_build_tiles_path(ctx)

    if build_tiles.exists() and _smoke_ok(build_tiles):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"valhalla tools already present at {build_tiles.parent}",
            )
        )
        _register_on_path(ctx)
        return

    url = VALHALLA_TOOLS["url_template"].format(
        version=VALHALLA_TOOLS["version"], filename=filename
    )
    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / _TOOL_REL
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target)

    if not build_tiles.exists():
        raise RuntimeError(
            f"extraction completed but {build_tiles} is missing — archive layout changed?"
        )
    if ctx.os_name != "Windows":
        _make_executable_tree(build_tiles.parent)
    if not _smoke_ok(build_tiles):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=(
                    f"warning: {build_tiles} --version smoke test did not "
                    "return a version string — continuing anyway"
                ),
            )
        )
    _register_on_path(ctx)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"valhalla tools ready at {build_tiles.parent}"))


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
    with tempfile.TemporaryDirectory(prefix="loki-valhalla-") as tmp:
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


def _make_executable_tree(bin_dir: Path) -> None:
    """chmod +x every regular file in ``bin_dir`` — the tarball carries
    multiple ``valhalla_build_*`` CLIs + the service daemon, all of which
    need the executable bit."""
    for entry in bin_dir.iterdir():
        if entry.is_file():
            mode = entry.stat().st_mode
            entry.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _register_on_path(ctx: StepContext) -> None:
    """Append ``tools/valhalla`` to ``ctx.tools`` so
    :meth:`StepContext.augmented_env` prepends the bin dir to ``PATH``
    for downstream subprocess calls. Idempotent."""
    if _TOOL_REL in ctx.tools:
        return
    ctx.tools = tuple(list(ctx.tools) + [_TOOL_REL])
