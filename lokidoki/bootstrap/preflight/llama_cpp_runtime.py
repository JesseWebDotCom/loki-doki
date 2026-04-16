"""Install + launch the prebuilt ``llama-server`` binary.

The upstream release layout:

- linux tarballs extract to a single ``llama-<tag>/`` top-level dir
  carrying ``llama-server`` plus the shared ``libggml*`` payload.
- windows zip flattens everything to the archive root (``llama-server.exe``
  alongside ``ggml-*.dll``).

We flatten both into ``.lokidoki/llama.cpp/`` so the binary resolves at
``.lokidoki/llama.cpp/llama-server`` (unix) or
``.lokidoki/llama.cpp/llama-server.exe`` (windows). The shared libraries
need to live next to the binary, so we do not split the layout further.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import LLAMA_CPP, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "install-llm-engine"
_WARM_STEP_ID = "warm-resident-llm"


def llama_server_path(ctx: StepContext) -> Path:
    """Delegate to :meth:`StepContext.binary_path` so the LAYOUT dict
    stays the single source of truth for on-disk layout."""
    return ctx.binary_path("llama_server")


async def ensure_llama_cpp(ctx: StepContext) -> None:
    """Download + extract the profile's llama.cpp release into ``.lokidoki/llama.cpp/``."""
    binary = llama_server_path(ctx)
    if binary.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"llama-server already present at {binary}"))
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = LLAMA_CPP["artifacts"]
    if key not in artifacts:
        raise RuntimeError(
            f"no llama.cpp artifact pinned for os/arch={key}; "
            "mac uses MLX and Intel macs are unsupported"
        )
    filename, sha256 = artifacts[key]

    # Guard: the Pi 5 artifact is the plain CPU+NEON build. If a future
    # refactor accidentally points pi_cpu at a Vulkan release the runtime
    # would fail to init the GPU — surface that immediately.
    if ctx.profile == "pi_cpu" and "vulkan" in filename:
        raise RuntimeError(
            f"pi_cpu must use the CPU/NEON llama.cpp build, not {filename!r}"
        )

    url = LLAMA_CPP["url_template"].format(
        version=LLAMA_CPP["version"], filename=filename
    )

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / "llama.cpp"
    is_zip = filename.endswith(".zip")
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target, is_zip=is_zip)

    if not binary.exists():
        raise RuntimeError(
            f"extraction completed but {binary} is missing — archive layout changed?"
        )
    if ctx.os_name != "Windows":
        _make_executable(binary)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"llama-server ready at {binary}"))


async def start_llama_server(
    ctx: StepContext,
    model_path: Path,
    *,
    port: int = 11434,
    context_size: int = 8192,
    ready_timeout_s: float = 120.0,
) -> int:
    """Spawn ``llama-server`` in the background and wait for ``/health`` to report ready.

    Idempotent: reuses a healthy server already on ``port`` so a re-run of
    the wizard doesn't fight the prior detached process for the bind.
    """
    if _probe(f"http://127.0.0.1:{port}/health"):
        ctx.emit(
            StepLog(
                step_id=_WARM_STEP_ID,
                line=f"llama-server already healthy on :{port} — reusing",
            )
        )
        return port

    binary = llama_server_path(ctx)
    if not binary.exists():
        raise RuntimeError(f"llama-server is not installed at {binary}")
    if not model_path.exists():
        raise RuntimeError(f"model weights missing at {model_path}")

    cmd = [
        str(binary),
        "--model", str(model_path),
        "--host", "127.0.0.1",
        "--port", str(port),
        "--ctx-size", str(context_size),
    ]
    if ctx.profile != "pi_cpu":
        # Vulkan build: offload every layer the GPU can hold. llama-server
        # silently clamps ``-ngl`` to the real layer count.
        cmd += ["-ngl", "999"]

    log_dir = ctx.data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "llm.log"

    ctx.emit(StepLog(step_id=_WARM_STEP_ID, line=f"starting llama-server: {' '.join(cmd)}"))

    kwargs: dict = {
        "stdout": open(log_path, "ab"),
        "stderr": subprocess.STDOUT,
        "cwd": str(binary.parent),
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(cmd, **kwargs)  # noqa: S603 — path validated above

    await _wait_for_health(f"http://127.0.0.1:{port}/health", ready_timeout_s)
    ctx.emit(StepLog(step_id=_WARM_STEP_ID, line=f"llama-server up on :{port}, loading weights into memory..."))
    # /health flips green when the HTTP server is bound, but llama.cpp
    # finishes mmap'ing the weights and warming the KV cache only on the
    # first inference. A 1-token completion forces that to happen here
    # so the user's first real chat doesn't pay the cold-start tax.
    started = time.monotonic()
    await _force_model_load(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        ready_timeout_s,
    )
    ctx.emit(
        StepLog(
            step_id=_WARM_STEP_ID,
            line=f"llama-server model resident in {time.monotonic() - started:.1f}s",
        )
    )
    return port


async def _force_model_load(url: str, timeout_s: float) -> None:
    """POST a 1-token completion so llama-server finishes loading the weights."""
    body = json.dumps(
        {
            "messages": [{"role": "user", "content": "."}],
            "max_tokens": 1,
            "temperature": 0,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    def _post() -> None:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            resp.read()

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _post)


async def _wait_for_health(url: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    loop = asyncio.get_event_loop()
    while time.monotonic() < deadline:
        try:
            ok = await loop.run_in_executor(None, _probe, url)
        except Exception:  # noqa: BLE001 — transient startup conditions
            ok = False
        if ok:
            return
        await asyncio.sleep(0.5)
    raise RuntimeError(f"llama-server did not report ready at {url} within {timeout_s:.0f}s")


def _probe(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 500
    except urllib.error.URLError:
        return False


def _extract(archive: Path, target: Path, *, is_zip: bool) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="loki-llamacpp-") as tmp:
        tmp_path = Path(tmp)
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp_path)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(tmp_path)
        source = _locate_server_source(tmp_path)
        for item in source.iterdir():
            shutil.move(str(item), str(target / item.name))


def _locate_server_source(tmp_path: Path) -> Path:
    # Linux tarballs use an inner ``llama-<tag>/`` dir; windows zips flatten.
    for candidate in ("llama-server", "llama-server.exe"):
        if (tmp_path / candidate).exists():
            return tmp_path
    dirs = [e for e in tmp_path.iterdir() if e.is_dir()]
    if len(dirs) == 1:
        inner = dirs[0]
        if (inner / "llama-server").exists() or (inner / "llama-server.exe").exists():
            return inner
    raise RuntimeError(
        f"could not locate llama-server inside extracted archive: {list(tmp_path.iterdir())}"
    )


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    # The shared libs next to llama-server also need r-x; run a blanket
    # chmod so rpath-loaded ``libggml*.so`` / ``.dylib`` entries are
    # readable.
    for sibling in path.parent.iterdir():
        try:
            mode = sibling.stat().st_mode
            if sibling.is_file():
                sibling.chmod(mode | stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        except OSError:
            continue
    _ = os  # quiet unused-import for future use
