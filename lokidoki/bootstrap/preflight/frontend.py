"""``npm ci`` + ``vite build`` orchestration as wizard steps.

The old ``run.sh`` shelled out to npm directly with bash-level staleness
checks. Both are now wizard-visible: the skip logic moves into Python so
the same behaviour runs identically on every profile, and the subprocess
output streams through :meth:`StepContext.run_streamed`.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

from ..context import StepContext
from ..events import StepDone, StepLog


_log = logging.getLogger(__name__)
_INSTALL_STEP = "install-frontend-deps"
_BUILD_STEP = "build-frontend"


def _frontend_dir(ctx: StepContext) -> Path:
    return ctx.data_dir.parent.resolve() / "frontend"


def _npm_cmd(ctx: StepContext) -> str:
    """Resolve the platform-appropriate npm launcher path."""
    node_root = ctx.data_dir / "node"
    if ctx.os_name == "Windows":
        return str(node_root / "npm.cmd")
    return str(node_root / "bin" / "npm")


async def install_frontend_deps(ctx: StepContext) -> None:
    """Run ``npm ci`` unless ``node_modules`` is already current."""
    started = time.monotonic()
    frontend = _frontend_dir(ctx)
    lockfile = frontend / "package-lock.json"
    installed_marker = frontend / "node_modules" / ".package-lock.json"

    if not lockfile.exists():
        raise RuntimeError(f"frontend/package-lock.json missing at {lockfile}")

    if _hashes_match(lockfile, installed_marker):
        ctx.emit(
            StepLog(
                step_id=_INSTALL_STEP,
                line="frontend dependencies already current — skipping npm ci",
            )
        )
        ctx.emit(StepDone(step_id=_INSTALL_STEP, duration_s=0.0))
        return

    env = ctx.augmented_env()
    npm = _npm_cmd(ctx)

    ci_cmd = [npm, "ci"]
    ctx.emit(StepLog(step_id=_INSTALL_STEP, line=f"running: {' '.join(ci_cmd)}"))
    rc = await ctx.run_streamed(ci_cmd, _INSTALL_STEP, cwd=frontend, env=env)
    if rc != 0:
        # ``npm ci`` refuses to proceed when package-lock.json drifts from
        # package.json (EUSAGE). The repo currently has that drift — fall
        # back to ``npm install`` so a fresh checkout can still reach
        # ``spawn-app``. Future chunks that repair the lockfile can drop
        # this fallback.
        ctx.emit(
            StepLog(
                step_id=_INSTALL_STEP,
                line=f"npm ci exited {rc} — retrying with npm install",
            )
        )
        rc = await ctx.run_streamed(
            [npm, "install", "--no-audit", "--no-fund"],
            _INSTALL_STEP,
            cwd=frontend,
            env=env,
        )
        if rc != 0:
            raise RuntimeError(f"npm install failed (exit {rc})")
    ctx.emit(
        StepLog(
            step_id=_INSTALL_STEP,
            line=f"frontend deps ready in {time.monotonic() - started:.1f}s",
        )
    )


async def build_frontend(ctx: StepContext) -> None:
    """Run ``npm run build`` unless ``dist/`` is newer than every source."""
    started = time.monotonic()
    frontend = _frontend_dir(ctx)
    dist_marker = frontend / "dist" / "index.html"
    src_dir = frontend / "src"

    if _dist_is_current(dist_marker, src_dir):
        ctx.emit(
            StepLog(
                step_id=_BUILD_STEP,
                line="frontend bundle already current — skipping vite build",
            )
        )
        ctx.emit(StepDone(step_id=_BUILD_STEP, duration_s=0.0))
        return

    cmd = [_npm_cmd(ctx), "run", "build"]
    ctx.emit(StepLog(step_id=_BUILD_STEP, line=f"running: {' '.join(cmd)}"))
    rc = await ctx.run_streamed(cmd, _BUILD_STEP, cwd=frontend, env=ctx.augmented_env())
    if rc != 0:
        raise RuntimeError(f"vite build failed (exit {rc})")
    ctx.emit(
        StepLog(
            step_id=_BUILD_STEP,
            line=f"vite build completed in {time.monotonic() - started:.1f}s",
        )
    )


def _hashes_match(lockfile: Path, installed_marker: Path) -> bool:
    if not installed_marker.exists():
        return False
    try:
        return _sha256_file(lockfile) == _sha256_file(installed_marker)
    except OSError:
        return False


def _dist_is_current(dist_marker: Path, src_dir: Path) -> bool:
    if not dist_marker.exists() or not src_dir.exists():
        return False
    try:
        dist_mtime = dist_marker.stat().st_mtime
    except OSError:
        return False
    for path in src_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime > dist_mtime:
                return False
        except OSError:
            return False
    return True


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
