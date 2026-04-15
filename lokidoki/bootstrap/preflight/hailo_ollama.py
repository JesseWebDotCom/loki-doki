"""Install + launch the ``hailo-ollama`` server on ``pi_hailo``.

hailo-ollama is the only LLM engine LokiDoki ships that runs from a
fixed external port — :8000 — because it expects to be polled by clients
that already speak Ollama's HTTP API. The wizard mirrors that fixed
port: nothing else binds :8000 on ``pi_hailo`` (the FastAPI app moves
to :7860 — see :func:`run_app.app_port_for`).
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import HAILO_OLLAMA, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID_INSTALL = "install-hailo-ollama"
_STEP_ID_WARM = "warm-resident-llm"
HAILO_OLLAMA_PORT = 8000


def hailo_ollama_binary(ctx: StepContext) -> Path:
    """Return the on-disk path to the extracted ``hailo-ollama`` binary."""
    return ctx.data_dir / "hailo_ollama" / "hailo-ollama"


async def ensure_hailo_ollama(ctx: StepContext) -> None:
    """Download + extract hailo-ollama, then ensure the server is running.

    Idempotent: if the binary already exists we skip the download. If
    something is already serving :8000 we treat that as good and skip the
    spawn. Otherwise we ``Popen`` the binary detached so the wizard's
    handoff to FastAPI doesn't kill it.
    """
    binary = hailo_ollama_binary(ctx)
    if not binary.exists():
        await _install_hailo_ollama(ctx)
    if not binary.exists():
        raise RuntimeError(
            f"hailo-ollama install completed but {binary} is missing — "
            "archive layout changed?"
        )
    if _probe_version(f"http://127.0.0.1:{HAILO_OLLAMA_PORT}/api/version"):
        ctx.emit(
            StepLog(
                step_id=_STEP_ID_INSTALL,
                line=f"hailo-ollama already serving :{HAILO_OLLAMA_PORT}",
            )
        )
        return
    await start_hailo_ollama(ctx)


async def _install_hailo_ollama(ctx: StepContext) -> None:
    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = HAILO_OLLAMA["artifacts"]
    if key not in artifacts:
        raise RuntimeError(
            f"no hailo-ollama artifact pinned for os/arch={key}; "
            "hailo-ollama only runs on linux/aarch64 (Raspberry Pi 5 + Hailo HAT)"
        )
    filename, sha256 = artifacts[key]
    url = HAILO_OLLAMA["url_template"].format(
        version=HAILO_OLLAMA["version"], filename=filename
    )

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID_INSTALL, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID_INSTALL, sha256=sha256)

    target = ctx.data_dir / "hailo_ollama"
    ctx.emit(StepLog(step_id=_STEP_ID_INSTALL, line=f"extracting into {target}"))
    _extract_tarball(archive, target)

    binary = hailo_ollama_binary(ctx)
    if binary.exists():
        _make_executable(binary)
        ctx.emit(
            StepLog(step_id=_STEP_ID_INSTALL, line=f"hailo-ollama ready at {binary}")
        )


async def start_hailo_ollama(
    ctx: StepContext,
    *,
    ready_timeout_s: float = 60.0,
) -> int:
    """Spawn ``hailo-ollama serve`` and wait for ``/api/version``."""
    binary = hailo_ollama_binary(ctx)
    if not binary.exists():
        raise RuntimeError(f"hailo-ollama is not installed at {binary}")

    log_dir = ctx.data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "llm.log"

    cmd = [str(binary), "serve"]
    ctx.emit(
        StepLog(
            step_id=_STEP_ID_WARM,
            line=f"starting hailo-ollama: {' '.join(cmd)}",
        )
    )

    kwargs: dict = {
        "stdout": open(log_path, "ab"),
        "stderr": subprocess.STDOUT,
        "cwd": str(binary.parent),
        "env": ctx.augmented_env(),
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(cmd, **kwargs)  # noqa: S603 — path validated above

    url = f"http://127.0.0.1:{HAILO_OLLAMA_PORT}/api/version"
    await _wait_for_health(url, ready_timeout_s)
    ctx.emit(
        StepLog(
            step_id=_STEP_ID_WARM,
            line=f"hailo-ollama healthy on :{HAILO_OLLAMA_PORT}",
        )
    )
    return HAILO_OLLAMA_PORT


async def _wait_for_health(url: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    loop = asyncio.get_event_loop()
    while time.monotonic() < deadline:
        try:
            ok = await loop.run_in_executor(None, _probe_version, url)
        except Exception:  # noqa: BLE001 — transient startup conditions
            ok = False
        if ok:
            return
        await asyncio.sleep(0.5)
    raise RuntimeError(
        f"hailo-ollama did not report ready at {url} within {timeout_s:.0f}s"
    )


def _probe_version(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except urllib.error.URLError:
        return False
    except OSError:
        return False


def _extract_tarball(archive: Path, target: Path) -> None:
    """Extract ``archive`` into ``target`` flattening any single inner dir."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-hailo-ollama-") as tmp:
        tmp_path = Path(tmp)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(tmp_path)
        source = _flatten_source(tmp_path)
        for item in source.iterdir():
            shutil.move(str(item), str(target / item.name))


def _flatten_source(tmp_path: Path) -> Path:
    if (tmp_path / "hailo-ollama").exists():
        return tmp_path
    dirs = [e for e in tmp_path.iterdir() if e.is_dir()]
    if len(dirs) == 1 and (dirs[0] / "hailo-ollama").exists():
        return dirs[0]
    raise RuntimeError(
        f"could not locate hailo-ollama inside extracted archive: "
        f"{list(tmp_path.iterdir())}"
    )


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


__all__ = [
    "ensure_hailo_ollama",
    "start_hailo_ollama",
    "hailo_ollama_binary",
    "HAILO_OLLAMA_PORT",
]
