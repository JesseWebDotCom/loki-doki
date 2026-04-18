"""Download Piper TTS voices for each profile.

Synthesis uses the ``piper-tts`` Python package in-process — no CLI
binary needed. This module only handles downloading the voice model
files (``.onnx`` + ``.onnx.json``) from HuggingFace into
``.lokidoki/piper/voices/``.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import PIPER_VOICES


_log = logging.getLogger(__name__)
_STEP_ID = "install-piper"


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
