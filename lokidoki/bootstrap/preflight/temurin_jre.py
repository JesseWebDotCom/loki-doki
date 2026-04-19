"""Install the pinned Temurin JRE into ``.lokidoki/jre/``."""
from __future__ import annotations

import logging
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote

from ..context import StepContext
from ..events import StepLog
from ..versions import TEMURIN_JRE, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "install-jre"
_TOOL_NAME = "tools/jre"


async def ensure_temurin_jre(ctx: StepContext) -> None:
    """Download + extract the pinned Temurin JRE into ``.lokidoki/jre/``."""
    java_bin = ctx.binary_path("java")
    if java_bin.exists() and _smoke_ok(java_bin):
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"temurin jre already present at {java_bin}"))
        _register_on_path(ctx)
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = TEMURIN_JRE["artifacts"]
    if key not in artifacts:
        raise RuntimeError(f"no temurin jre artifact pinned for os/arch={key}")
    filename, sha256 = artifacts[key]

    version = quote(TEMURIN_JRE["version"], safe="")
    url = TEMURIN_JRE["url_template"].format(version=version, filename=filename)
    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / _TOOL_NAME
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target, is_zip=filename.endswith(".zip"))

    if not java_bin.exists():
        raise RuntimeError(
            f"extraction completed but {java_bin} is missing — archive layout changed?"
        )
    if ctx.os_name != "Windows":
        _make_bin_executable(target / "bin")
    if not _smoke_ok(java_bin):
        raise RuntimeError(f"java smoke test failed for {java_bin}")
    _register_on_path(ctx)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"temurin jre ready at {java_bin}"))


def _smoke_ok(java_bin: Path) -> bool:
    try:
        out = subprocess.run(
            [str(java_bin), "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    probe = (out.stdout + out.stderr).strip()
    if probe:
        _log.info("java -version: %s", probe.replace("\n", " | "))
    return bool(probe)


def _extract(archive: Path, target: Path, *, is_zip: bool) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-jre-") as tmp:
        tmp_path = Path(tmp)
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp_path)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(tmp_path)
        source = _flatten_wrapper(tmp_path)
        source = _normalize_vendor_home(source)
        for item in source.iterdir():
            shutil.move(str(item), str(target / item.name))


def _flatten_wrapper(tmp_path: Path) -> Path:
    entries = list(tmp_path.iterdir())
    if len(entries) != 1 or not entries[0].is_dir():
        raise RuntimeError(
            f"unexpected temurin archive layout: {[entry.name for entry in entries]}"
        )
    return entries[0]


def _normalize_vendor_home(source: Path) -> Path:
    home = source / "Contents" / "Home"
    if home.is_dir():
        return home
    return source


def _make_bin_executable(bin_dir: Path) -> None:
    for entry in bin_dir.iterdir():
        if entry.is_file():
            mode = entry.stat().st_mode
            entry.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _register_on_path(ctx: StepContext) -> None:
    if _TOOL_NAME in ctx.tools:
        return
    ctx.tools = tuple(list(ctx.tools) + [_TOOL_NAME])
