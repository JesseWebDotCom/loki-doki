"""Windows path resolution for :meth:`StepContext.binary_path`.

Passing ``os_name="Windows"`` flips the :func:`_is_windows` branch in
``context.py`` without touching global ``os.name`` / ``sys.platform``
state — the latter would detonate :mod:`pathlib` on a non-windows
host (``pathlib.WindowsPath`` refuses to instantiate). The binary path
must end in ``.exe`` for every registered tool.
"""
from __future__ import annotations

from pathlib import Path, PureWindowsPath

import pytest

from lokidoki.bootstrap.context import StepContext


_EVENTS: list = []


def _emit(_evt) -> None:  # pragma: no cover — events are not asserted here
    _EVENTS.append(_evt)


def _win_ctx(tmp_path: Path) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="windows",
        arch="x86_64",
        os_name="Windows",
        emit=_emit,
    )


@pytest.mark.parametrize(
    "name,expected_suffix",
    [
        ("python", "python/python.exe"),
        ("uv", "uv/uv.exe"),
        ("node", "node/node.exe"),
        ("llama_server", "llama.cpp/llama-server.exe"),
        ("piper", "piper/piper.exe"),
    ],
)
def test_binary_path_registered_tools(
    tmp_path: Path, name: str, expected_suffix: str
) -> None:
    ctx = _win_ctx(tmp_path)
    resolved = ctx.binary_path(name)
    assert resolved.suffix == ".exe"
    # ``PurePosixPath.as_posix()`` gives us a separator-agnostic tail we
    # can compare regardless of host OS.
    assert resolved.as_posix().endswith(expected_suffix)


def test_binary_path_unknown_tool_uses_fallback(tmp_path: Path) -> None:
    """Unregistered tools keep the historical ``<data>/<name>/<name>.exe``
    convention so the helper never fails silently."""
    ctx = _win_ctx(tmp_path)
    resolved = ctx.binary_path("someplugin")
    assert resolved == tmp_path / "someplugin" / "someplugin.exe"


def test_tool_bin_dir_is_flat_on_windows(tmp_path: Path) -> None:
    """Windows tool layout drops the ``bin/`` prefix — the PATH helper
    must point at the tool's root."""
    ctx = _win_ctx(tmp_path)
    bin_dir = ctx._tool_bin_dir("uv")  # noqa: SLF001 — intentional
    assert bin_dir == tmp_path / "uv"


def test_augmented_env_uses_windows_pathsep(tmp_path: Path) -> None:
    """``os.pathsep`` resolves to ``;`` on windows runners — but the
    helper reads it from ``os`` directly, so assert it does not hard-code
    ``:`` and does compose the root directly (no ``bin/``)."""
    ctx = _win_ctx(tmp_path)
    (tmp_path / "uv").mkdir()
    (tmp_path / "uv" / "uv.exe").write_bytes(b"")
    env = ctx.augmented_env()
    # The tool root should appear in PATH, not a ``bin/`` subpath.
    assert any(
        Path(entry) == tmp_path / "uv"
        for entry in env["PATH"].split(__import__("os").pathsep)
    )


def test_windows_paths_are_path_objects(tmp_path: Path) -> None:
    """Regression: every ``binary_path`` return must be ``pathlib.Path``
    — callers pass it to :func:`subprocess.Popen` and rely on ``str``
    conversion yielding a windows-native form."""
    ctx = _win_ctx(tmp_path)
    for name in ("python", "uv", "node", "llama_server", "piper"):
        resolved = ctx.binary_path(name)
        assert isinstance(resolved, Path)
        # Windows semantics: when we cast to PureWindowsPath, the string
        # round-trip uses backslashes and preserves the ``.exe`` suffix.
        winified = PureWindowsPath(resolved.as_posix())
        assert winified.suffix == ".exe"
