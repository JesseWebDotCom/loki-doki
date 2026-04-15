"""StepContext — the sandbox every pipeline step runs against.

Wraps the on-disk layout (``.lokidoki/``), the active profile, and an
``emit`` callable the step uses to publish :mod:`events` into the
pipeline. The ``run_streamed`` / ``download`` methods are declared here
and implemented in chunk 3 — this chunk ships the shell and the pure
path helpers (``binary_path``, ``augmented_env``) that other chunks
depend on.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Optional

from .events import Event


_DEFAULT_TOOLS: tuple[str, ...] = (
    "python",
    "uv",
    "node",
    "llama.cpp",
    "mlx",
    "hailo_ollama",
    "piper",
    "whisper",
)


@dataclass
class StepContext:
    """Shared state + capabilities handed to every step ``run()``.

    Fields:
        data_dir: Root ``.lokidoki/`` directory for this install.
        profile: Active profile string — ``mac`` / ``windows`` / ``linux``
            / ``pi_cpu`` / ``pi_hailo``.
        arch: ``platform.machine()`` — ``arm64``, ``aarch64``, ``x86_64``.
        os_name: ``platform.system()`` — ``Darwin`` / ``Windows`` / ``Linux``.
        emit: Callback each step uses to publish a pipeline event.
        tools: Names of subdirectories under ``data_dir`` whose ``bin/`` we
            prepend to PATH inside :meth:`augmented_env`. Defaults to the
            set of tools chunks 3-7 land.
    """

    data_dir: Path
    profile: str
    arch: str
    os_name: str
    emit: Callable[[Event], None]
    tools: tuple[str, ...] = field(default=_DEFAULT_TOOLS)

    # ------------------------------------------------------------------
    # async capabilities — bodies land in chunk 3
    # ------------------------------------------------------------------
    async def run_streamed(
        self,
        cmd: list[str],
        step_id: str,
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
    ) -> int:
        """Run ``cmd``, stream stdout/stderr as :class:`StepLog` events, return exit code."""
        raise NotImplementedError("chunk 3 implements run_streamed")

    async def download(
        self,
        url: str,
        dest: Path,
        step_id: str,
        sha256: Optional[str] = None,
    ) -> None:
        """Download ``url`` to ``dest``, emitting :class:`StepProgress`, verifying SHA-256."""
        raise NotImplementedError("chunk 3 implements download")

    # ------------------------------------------------------------------
    # pure path/env helpers — used by later chunks, safe to implement now
    # ------------------------------------------------------------------
    def augmented_env(self) -> dict[str, str]:
        """Return ``os.environ`` with every embedded tool's ``bin`` dir on PATH.

        Only directories that actually exist get prepended, so the function
        works even before any tool has been installed. Preserves platform
        PATH separator (``;`` on Windows, ``:`` elsewhere).
        """
        env = dict(os.environ)
        extras: list[str] = []
        for tool in self.tools:
            bin_dir = self._tool_bin_dir(tool)
            if bin_dir.exists():
                extras.append(str(bin_dir))
        if extras:
            sep = os.pathsep
            current = env.get("PATH", "")
            env["PATH"] = sep.join(extras + ([current] if current else []))
        return env

    def binary_path(self, name: str) -> Path:
        """Resolve the expected on-disk path for an embedded tool's binary.

        Unix: ``<data_dir>/<name>/bin/<name>``. Windows: ``<data_dir>/<name>/<name>.exe``.
        """
        root = self.data_dir / name
        if self.os_name == "Windows" or sys.platform == "win32":
            return root / f"{name}.exe"
        return root / "bin" / name

    def _tool_bin_dir(self, name: str) -> Path:
        root = self.data_dir / name
        if self.os_name == "Windows" or sys.platform == "win32":
            return root
        return root / "bin"
