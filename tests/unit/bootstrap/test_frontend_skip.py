"""``build_frontend`` short-circuits when ``frontend/dist/`` is current.

The skip path emits ``StepDone(duration_s=0)`` + a log line and must
not spawn a subprocess. We hook ``run_streamed`` to a sentinel that
fails the test if it's ever invoked.
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event, StepDone
from lokidoki.bootstrap.preflight.frontend import build_frontend, install_frontend_deps


def _prime_frontend(root: Path) -> Path:
    frontend = root / "frontend"
    (frontend / "src").mkdir(parents=True)
    (frontend / "src" / "main.tsx").write_text("// source\n")
    # shift src mtime into the past so dist/index.html is strictly newer
    old = time.time() - 600
    os.utime(frontend / "src" / "main.tsx", (old, old))
    (frontend / "dist").mkdir(parents=True)
    (frontend / "dist" / "index.html").write_text("<!doctype html>\n")
    (frontend / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
    return frontend


def _ctx(data_dir: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=data_dir,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )


def test_build_frontend_skips_when_dist_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _prime_frontend(tmp_path)
    data_dir = tmp_path / ".lokidoki"
    data_dir.mkdir()

    async def _fail(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        raise AssertionError(f"subprocess should not spawn: {cmd}")

    monkeypatch.setattr(StepContext, "run_streamed", _fail)

    events: list[Event] = []
    ctx = _ctx(data_dir, events)
    asyncio.run(build_frontend(ctx))

    done = [e for e in events if isinstance(e, StepDone) and e.step_id == "build-frontend"]
    assert done, "build_frontend did not emit StepDone on skip"
    assert done[0].duration_s == 0.0


def test_install_frontend_deps_skips_when_node_modules_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend = _prime_frontend(tmp_path)
    (frontend / "node_modules").mkdir()
    import shutil

    shutil.copy(
        frontend / "package-lock.json",
        frontend / "node_modules" / ".package-lock.json",
    )
    data_dir = tmp_path / ".lokidoki"
    data_dir.mkdir()

    async def _fail(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        raise AssertionError(f"subprocess should not spawn: {cmd}")

    monkeypatch.setattr(StepContext, "run_streamed", _fail)

    events: list[Event] = []
    ctx = _ctx(data_dir, events)
    asyncio.run(install_frontend_deps(ctx))

    done = [e for e in events if isinstance(e, StepDone) and e.step_id == "install-frontend-deps"]
    assert done, "install_frontend_deps did not emit StepDone on skip"
    assert done[0].duration_s == 0.0
