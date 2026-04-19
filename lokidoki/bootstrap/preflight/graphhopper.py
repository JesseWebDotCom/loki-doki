"""Download the pinned GraphHopper JAR into ``.lokidoki/tools/graphhopper/``."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import GRAPHHOPPER


_log = logging.getLogger(__name__)
_STEP_ID = "install-graphhopper"


async def ensure_graphhopper(ctx: StepContext) -> None:
    """Download the pinned GraphHopper JAR and smoke test it with Java."""
    java_bin = ctx.binary_path("java")
    jar_path = ctx.binary_path("graphhopper_jar")
    if jar_path.exists() and _smoke_ok(java_bin, jar_path):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"graphhopper already present at {jar_path}",
            )
        )
        return

    jar_path.parent.mkdir(parents=True, exist_ok=True)
    url = GRAPHHOPPER["url_template"].format(
        version=GRAPHHOPPER["version"],
        filename=GRAPHHOPPER["filename"],
    )
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, jar_path, _STEP_ID, sha256=GRAPHHOPPER["sha256"])

    if not _smoke_ok(java_bin, jar_path):
        raise RuntimeError(f"graphhopper smoke test failed for {jar_path}")
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"graphhopper ready at {jar_path}"))


def _smoke_ok(java_bin: Path, jar_path: Path) -> bool:
    if not java_bin.exists() or not jar_path.exists():
        return False
    try:
        out = subprocess.run(
            [str(java_bin), "-jar", str(jar_path), "--help"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    probe = (out.stdout + out.stderr).strip()
    if probe:
        _log.info("graphhopper --help: %s", probe.replace("\n", " | "))
    return out.returncode == 0 and bool(probe)
