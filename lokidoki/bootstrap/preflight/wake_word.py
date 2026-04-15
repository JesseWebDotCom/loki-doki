"""Warm the wake-word engine cache.

``openwakeword`` is pulled in by ``uv sync`` in chunk 3. The first
``Model()`` instantiation downloads its default melspectrogram +
embedding models, which we want to happen inside the wizard rather
than on the first microphone capture.
"""
from __future__ import annotations

import logging

from ..context import StepContext
from ..events import StepLog


_log = logging.getLogger(__name__)
_STEP_ID = "install-wake-word"
_SUPPORTED = ("openWakeWord",)


async def ensure_wake_word(ctx: StepContext, engine: str) -> None:
    if engine not in _SUPPORTED:
        raise RuntimeError(
            f"unsupported wake-word engine {engine!r} (expected one of {_SUPPORTED})"
        )

    project_root = ctx.data_dir.parent.resolve()
    venv_python = project_root / ".venv" / (
        "Scripts/python.exe" if ctx.os_name == "Windows" else "bin/python"
    )
    py_bin = venv_python if venv_python.exists() else ctx.binary_path("python")
    if not py_bin.exists():
        raise RuntimeError(f"python interpreter missing at {py_bin}")

    env = ctx.augmented_env()
    env["PYTHONPATH"] = str(project_root)

    # Tolerate ImportError: the openwakeword Python package is expected
    # to be added to pyproject by the voice-subsystem chunk. Until then
    # the warm-up is a no-op so bootstrap can still reach spawn-app.
    script = (
        "import sys, time\n"
        "try:\n"
        "    from openwakeword.model import Model\n"
        "except ImportError:\n"
        "    print('openwakeword not installed yet — skipping warm-up', file=sys.stderr)\n"
        "    sys.exit(0)\n"
        "t0 = time.monotonic()\n"
        "Model()\n"
        "print(f'openwakeword warmed in {time.monotonic()-t0:.2f}s')\n"
    )
    cmd = [str(py_bin), "-c", script]
    ctx.emit(StepLog(step_id=_STEP_ID, line=f"warming {engine} default model"))
    rc = await ctx.run_streamed(cmd, _STEP_ID, cwd=project_root, env=env)
    if rc != 0:
        raise RuntimeError(f"openwakeword warm-up failed (exit {rc})")
