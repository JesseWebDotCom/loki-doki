"""``ensure_mlx`` unit behaviour.

Full import probing requires the real mlx-lm wheel, which is only
available on macOS arm64 — any other host installs nothing for this
dep via the ``sys_platform`` marker. The unit test focuses on the
dispatcher's guard rails (OS refusal + venv python check) so CI can
run it everywhere; the actual import probe is exercised by the chunk 5
end-to-end verify on mac.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.mlx_runtime import ensure_mlx


def _ctx(tmp_path: Path, events: list[Event], os_name: str) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac" if os_name == "Darwin" else "linux",
        arch="arm64" if os_name == "Darwin" else "x86_64",
        os_name=os_name,
        emit=events.append,
    )


def test_ensure_mlx_refuses_non_darwin(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Linux")
    with pytest.raises(RuntimeError, match="macOS-only"):
        asyncio.run(ensure_mlx(ctx))


def test_ensure_mlx_requires_venv_python(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events, os_name="Darwin")
    # ``data_dir.parent/.venv`` does not exist in this tmp tree
    with pytest.raises(RuntimeError, match="venv python missing"):
        asyncio.run(ensure_mlx(ctx))


def test_ensure_mlx_surfaces_import_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the mlx_lm import returns non-zero, bubble up an actionable error."""
    # Build a fake venv python that exists (so the guard passes) but is
    # not actually executable Python — we swap ``ctx.run_streamed`` for
    # a stub that pretends the subprocess exited nonzero.
    venv_py = tmp_path.parent / ".venv" / "bin" / "python"
    venv_py.parent.mkdir(parents=True, exist_ok=True)
    venv_py.write_text("")
    venv_py.chmod(0o755)
    # Ensure the preflight resolves venv relative to ctx.data_dir.parent
    data_dir = tmp_path
    data_dir.mkdir(exist_ok=True)

    async def fail_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        return 1

    monkeypatch.setattr(StepContext, "run_streamed", fail_run_streamed)

    events: list[Event] = []
    ctx = StepContext(
        data_dir=data_dir,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )
    with pytest.raises(RuntimeError, match="mlx_lm import failed"):
        asyncio.run(ensure_mlx(ctx))
