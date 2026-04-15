"""Integration: download + extract python-build-standalone end-to-end.

Gated behind ``LOKIDOKI_SLOW_TESTS=1`` because it pulls a real ~30 MB
tarball from GitHub. Not wired into the default `pytest` run.
"""
from __future__ import annotations

import asyncio
import os
import platform
import subprocess
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.preflight import ensure_embedded_python
from lokidoki.bootstrap.versions import PYTHON_BUILD_STANDALONE


pytestmark = pytest.mark.skipif(
    os.environ.get("LOKIDOKI_SLOW_TESTS") != "1",
    reason="slow: set LOKIDOKI_SLOW_TESTS=1 to enable",
)


def test_ensure_embedded_python_installs_working_interpreter(tmp_path: Path) -> None:
    events = []

    def _emit(evt):
        events.append(evt)

    ctx = StepContext(
        data_dir=tmp_path,
        profile="mac" if platform.system() == "Darwin" else "linux",
        arch=platform.machine(),
        os_name=platform.system(),
        emit=_emit,
    )

    asyncio.run(ensure_embedded_python(ctx))

    py_bin = ctx.binary_path("python")
    assert py_bin.exists(), f"missing interpreter at {py_bin}"

    out = subprocess.run(
        [str(py_bin), "--version"], capture_output=True, text=True, timeout=10
    )
    assert out.returncode == 0
    expected = PYTHON_BUILD_STANDALONE["version"]
    combined = (out.stdout + out.stderr).strip()
    assert expected in combined, f"expected Python {expected} in {combined!r}"
