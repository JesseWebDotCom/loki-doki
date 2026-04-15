"""StepContext — the sandbox every pipeline step runs against.

Wraps the on-disk layout (``.lokidoki/``), the active profile, and an
``emit`` callable the step uses to publish :mod:`events` into the
pipeline. ``run_streamed`` shells out with live log fan-out;
``download`` streams HTTPS with SHA-256 verification.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .events import Event, StepLog, StepProgress


_log = logging.getLogger(__name__)


class IntegrityError(RuntimeError):
    """Download SHA-256 did not match the pinned value."""


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


_CHUNK_SIZE = 1024 * 1024  # 1 MB stream chunk


@dataclass
class StepContext:
    """Shared state + capabilities handed to every step ``run()``.

    Fields:
        data_dir: Root ``.lokidoki/`` directory for this install.
        profile: Active profile — ``mac`` / ``windows`` / ``linux`` /
            ``pi_cpu`` / ``pi_hailo``.
        arch: ``platform.machine()`` — ``arm64``, ``aarch64``, ``x86_64``.
        os_name: ``platform.system()`` — ``Darwin`` / ``Windows`` / ``Linux``.
        emit: Callback each step uses to publish a pipeline event.
        tools: Names of subdirectories under ``data_dir`` whose ``bin/`` we
            prepend to PATH inside :meth:`augmented_env`.
        handoff: Optional callable the ``spawn-app`` step uses to release
            the stdlib server's listening socket so FastAPI can bind :8000.
            Wired in by ``__main__`` after the HTTP server is constructed.
    """

    data_dir: Path
    profile: str
    arch: str
    os_name: str
    emit: Callable[[Event], None]
    tools: tuple[str, ...] = field(default=_DEFAULT_TOOLS)
    handoff: Optional[Callable[[], None]] = None

    # ------------------------------------------------------------------
    # async capabilities
    # ------------------------------------------------------------------
    async def run_streamed(
        self,
        cmd: list[str],
        step_id: str,
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
    ) -> int:
        """Run ``cmd``, stream stdout/stderr as :class:`StepLog` events."""
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(cwd) if cwd is not None else None,
            env=env,
        )
        assert proc.stdout is not None  # PIPE above guarantees this
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line:
                self.emit(StepLog(step_id=step_id, line=line, stream="stdout"))
        return await proc.wait()

    async def download(
        self,
        url: str,
        dest: Path,
        step_id: str,
        sha256: Optional[str] = None,
    ) -> None:
        """Download ``url`` to ``dest`` — streams 1 MB chunks, verifies SHA-256.

        Enforces HTTPS on both the initial URL and any redirect target.
        Writes to ``<dest>.part`` first and only renames on a successful
        hash match; an ``IntegrityError`` deletes the partial file so the
        next run retries cleanly.
        """
        if not url.startswith("https://"):
            raise IntegrityError(f"download url must be https: {url}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        loop = asyncio.get_event_loop()
        digest = await loop.run_in_executor(
            None, self._download_blocking, url, part, step_id
        )
        if sha256 and digest.lower() != sha256.lower():
            try:
                part.unlink()
            except OSError:
                pass
            raise IntegrityError(
                f"sha256 mismatch for {url}: expected {sha256}, got {digest} — "
                "retry (likely a corrupted download)."
            )
        if dest.exists():
            dest.unlink()
        part.replace(dest)

    def _download_blocking(self, url: str, part: Path, step_id: str) -> str:
        ssl_ctx = ssl.create_default_context()
        req = urllib.request.Request(
            url, headers={"User-Agent": "LokiDoki-Bootstrap/0.1"}
        )
        h = hashlib.sha256()
        done = 0
        with urllib.request.urlopen(req, context=ssl_ctx) as resp:
            if not getattr(resp, "url", url).startswith("https://"):
                raise IntegrityError(
                    f"redirect target must be https (got {resp.url!r})"
                )
            total_header = resp.headers.get("Content-Length")
            total = int(total_header) if total_header else None
            with open(part, "wb") as fp:
                while True:
                    chunk = resp.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    fp.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    pct = (done / total * 100.0) if total else 0.0
                    self.emit(
                        StepProgress(
                            step_id=step_id,
                            pct=pct,
                            bytes_done=done,
                            bytes_total=total,
                        )
                    )
        return h.hexdigest()

    # ------------------------------------------------------------------
    # pure path/env helpers
    # ------------------------------------------------------------------
    def augmented_env(self) -> dict[str, str]:
        """Return ``os.environ`` with every embedded tool's ``bin`` dir on PATH."""
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
        """Resolve the expected on-disk path for an embedded tool's binary."""
        root = self.data_dir / name
        if self.os_name == "Windows" or sys.platform == "win32":
            return root / f"{name}.exe"
        return root / "bin" / name

    def _tool_bin_dir(self, name: str) -> Path:
        root = self.data_dir / name
        if self.os_name == "Windows" or sys.platform == "win32":
            return root
        return root / "bin"
