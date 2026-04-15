"""Install the Piper TTS binary + one voice per profile.

Piper is CPU-only on every profile per ``CLAUDE.md`` — same code path
for mac/windows/linux/pi_cpu/pi_hailo. The binary lands at
``.lokidoki/piper/piper`` (unix) / ``.lokidoki/piper/piper.exe`` (windows)
and voices go into ``.lokidoki/piper/voices/``. Voice selection is
read from :data:`PLATFORM_MODELS[profile]["tts_voice"]` by the step
wrapper in ``steps.py``.
"""
from __future__ import annotations

import logging
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import PIPER, PIPER_VOICES, os_arch_key


_log = logging.getLogger(__name__)
_STEP_ID = "install-piper"


def _piper_binary(ctx: StepContext) -> Path:
    return ctx.binary_path("piper")


async def ensure_piper(ctx: StepContext) -> None:
    """Download + extract the Piper binary into ``.lokidoki/piper/``."""
    piper_bin = _piper_binary(ctx)
    if piper_bin.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"piper already present at {piper_bin}"))
        return

    key = os_arch_key(ctx.os_name, ctx.arch)
    artifacts = PIPER["artifacts"]
    if key not in artifacts:
        raise RuntimeError(f"no piper artifact pinned for os/arch={key}")
    filename, sha256 = artifacts[key]
    url = PIPER["url_template"].format(version=PIPER["version"], filename=filename)

    cache = ctx.data_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / filename

    ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading {url}"))
    await ctx.download(url, archive, _STEP_ID, sha256=sha256)

    target = ctx.data_dir / "piper"
    is_zip = filename.endswith(".zip")
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"extracting into {target}"))
    _extract(archive, target, is_zip=is_zip)

    if not piper_bin.exists():
        raise RuntimeError(
            f"extraction completed but {piper_bin} is missing — archive layout changed?"
        )
    if ctx.os_name != "Windows":
        _make_executable(piper_bin)
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"piper ready at {piper_bin}"))


async def ensure_tts_voice(ctx: StepContext, voice_id: str) -> None:
    """Download a Piper voice pair (``.onnx`` + ``.onnx.json``)."""
    if voice_id not in PIPER_VOICES:
        raise RuntimeError(f"piper voice {voice_id!r} not pinned in PIPER_VOICES")
    entries = PIPER_VOICES[voice_id]

    voices_dir = ctx.data_dir / "piper" / "voices"
    voices_dir.mkdir(parents=True, exist_ok=True)

    onnx_url, onnx_sha = entries["onnx"]
    onnx_dest = voices_dir / f"{voice_id}.onnx"
    if not onnx_dest.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading voice weights {onnx_url}"))
        await ctx.download(onnx_url, onnx_dest, _STEP_ID, sha256=onnx_sha)
    else:
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"voice weights already present: {onnx_dest.name}")
        )

    config_url, config_sha = entries["config"]
    config_dest = voices_dir / f"{voice_id}.onnx.json"
    if not config_dest.exists():
        ctx.emit(StepLog(step_id=_STEP_ID, line=f"downloading voice config {config_url}"))
        await ctx.download(config_url, config_dest, _STEP_ID, sha256=config_sha)
    else:
        ctx.emit(
            StepLog(step_id=_STEP_ID, line=f"voice config already present: {config_dest.name}")
        )


def _extract(archive: Path, target: Path, *, is_zip: bool) -> None:
    """Flatten any top-level ``piper/`` directory into ``target``."""
    if target.exists():
        # preserve any voices/ subdir a prior run cached
        voices = target / "voices"
        if voices.exists():
            saved = target.parent / "_voices_tmp"
            if saved.exists():
                shutil.rmtree(saved)
            shutil.move(str(voices), str(saved))
            shutil.rmtree(target)
            target.mkdir(parents=True)
            shutil.move(str(saved), str(target / "voices"))
        else:
            shutil.rmtree(target)
            target.mkdir(parents=True)
    else:
        target.mkdir(parents=True)

    with tempfile.TemporaryDirectory(prefix="loki-piper-") as tmp:
        tmp_path = Path(tmp)
        if is_zip:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp_path)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(tmp_path)
        source = _locate_piper_source(tmp_path)
        for item in source.iterdir():
            dest = target / item.name
            if dest.exists():
                continue
            shutil.move(str(item), str(dest))


def _locate_piper_source(tmp_path: Path) -> Path:
    for candidate in ("piper", "piper.exe"):
        if (tmp_path / candidate).exists():
            return tmp_path
    dirs = [e for e in tmp_path.iterdir() if e.is_dir()]
    if len(dirs) == 1:
        inner = dirs[0]
        if (inner / "piper").exists() or (inner / "piper.exe").exists():
            return inner
    raise RuntimeError(
        f"could not locate piper binary inside extracted archive: {list(tmp_path.iterdir())}"
    )


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
