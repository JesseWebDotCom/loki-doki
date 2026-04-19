"""Async subprocess wrappers for local PMTiles + Valhalla tile builds.

Chunk 3 of the maps-local-build plan: no remote CDN. Once a region's
``.osm.pbf`` has landed on disk, :func:`run_tippecanoe` turns it into
``streets.pmtiles`` and :func:`run_valhalla` turns it into the routing
tile tree under ``valhalla/``.

Both wrappers:

* Refuse to start when the binary is missing from ``PATH`` (the
  bootstrap preflight — chunk 1 — is responsible for installing it).
  On missing binary they raise :class:`ToolchainMissing` with a
  message pointing the user at ``./run.sh --maps-tools-only``.
* Stream stdout / stderr, parse progress markers, and call ``emit``
  with a :class:`MapInstallProgress` carrying repurposed
  ``bytes_done`` / ``bytes_total`` for percent/step progress (see
  :class:`MapInstallProgress` docstring).
* Honour ``cancel_event``: when set, the subprocess is SIGTERM'd and
  the partial output is removed before the wrapper returns. Callers
  should treat a cancel as :class:`asyncio.CancelledError`.
* Classify non-zero exits into :class:`BuildOutOfMemory` (OS OOM
  killer — exit code 137 on linux / -9 on posix) or
  :class:`BuildFailed` with the last stderr line as the surface
  string.

The store layer catches these and maps them onto the ``error`` field
of the terminal ``MapInstallProgress`` event that the SSE endpoint
forwards to the admin UI.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import signal
from pathlib import Path
from typing import Awaitable, Callable

from .models import MapInstallProgress

log = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────

class ToolchainMissing(RuntimeError):
    """A required binary is not on ``PATH``."""


class BuildOutOfMemory(RuntimeError):
    """Build subprocess was killed by the OS (almost always OOM)."""


class BuildFailed(RuntimeError):
    """Build subprocess exited non-zero for a non-OOM reason."""


_EmitFn = Callable[[MapInstallProgress], Awaitable[None]]

# Percent patterns tippecanoe prints — e.g. "  91.9%  12345/13000".
_TIPPECANOE_PCT = re.compile(rb"(\d{1,3}(?:\.\d+)?)\s*%")

# Valhalla's discrete build stages — the binary logs one of these
# names as it transitions. Order matters: it drives the step counter
# we report back over SSE.
_VALHALLA_STAGES = (
    "parse",
    "construct",
    "enhance",
    "hierarchy",
    "shortcuts",
    "restrictions",
    "transit",
    "bss",
    "elevation",
    "cleanup",
)


# ── Public entry points ───────────────────────────────────────────

async def run_tippecanoe(
    pbf: Path,
    out_pmtiles: Path,
    *,
    region_id: str,
    emit: _EmitFn,
    cancel_event: asyncio.Event,
) -> None:
    """Build ``streets.pmtiles`` from ``pbf`` via tippecanoe.

    The ``-y`` flags preserve the OSM ``building`` / ``height`` /
    ``min_height`` / ``building:levels`` attributes so the 3D-buildings
    layer (chunk 5) can render heights from the vector tiles — without
    them tippecanoe drops unknown tags and every building renders flat.
    """
    binary = _require_binary("tippecanoe")

    out_pmtiles.parent.mkdir(parents=True, exist_ok=True)
    scratch = out_pmtiles.with_suffix(out_pmtiles.suffix + ".partial")
    if scratch.exists():
        scratch.unlink()

    cmd = [
        binary,
        "-z14",
        "--drop-densest-as-needed",
        "--force",
        "-y", "building",
        "-y", "building:levels",
        "-y", "height",
        "-y", "min_height",
        "-o", str(scratch),
        str(pbf),
    ]

    async def _on_line(line: bytes) -> None:
        match = _TIPPECANOE_PCT.search(line)
        if match is None:
            return
        try:
            pct = int(float(match.group(1)))
        except ValueError:  # pragma: no cover — regex guarantees digits
            return
        pct = max(0, min(100, pct))
        await emit(MapInstallProgress(
            region_id=region_id, artifact="street",
            bytes_done=pct, bytes_total=100,
            phase="building_streets",
        ))

    await emit(MapInstallProgress(
        region_id=region_id, artifact="street",
        bytes_done=0, bytes_total=100,
        phase="building_streets",
    ))

    try:
        await _run_subprocess(
            cmd, tool="tippecanoe", on_line=_on_line,
            cancel_event=cancel_event,
        )
    except (asyncio.CancelledError, BuildFailed, BuildOutOfMemory):
        if scratch.exists():
            scratch.unlink()
        raise

    # Atomic rename once tippecanoe's own exit code says it's done.
    scratch.replace(out_pmtiles)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="street",
        bytes_done=100, bytes_total=100,
        phase="ready",
    ))


async def run_valhalla(
    pbf: Path,
    out_dir: Path,
    *,
    region_id: str,
    emit: _EmitFn,
    cancel_event: asyncio.Event,
) -> None:
    """Build the Valhalla routing tile tree under ``out_dir`` from ``pbf``.

    ``valhalla_build_tiles`` reads a JSON config; we synthesise a
    minimal one on the fly (same shape as
    :mod:`lokidoki.maps.routing.build_tiles`) that points the tile
    output at ``out_dir`` and pins concurrency to 1 — keeps peak RAM
    bounded on the Pi.
    """
    binary = _require_binary("valhalla_build_tiles")

    scratch = out_dir.with_suffix(".partial")
    if scratch.exists():
        shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True, exist_ok=True)

    config_path = scratch.parent / f"{scratch.name}.json"
    config_path.write_text(
        json.dumps({
            "mjolnir": {
                "tile_dir": str(scratch),
                "concurrency": 1,
            },
        }, indent=2),
        encoding="utf-8",
    )

    cmd = [binary, "-c", str(config_path), str(pbf)]

    state = {"stage": 0}
    total_stages = len(_VALHALLA_STAGES)

    async def _on_line(line: bytes) -> None:
        text = line.decode("utf-8", errors="replace").lower()
        for idx, stage in enumerate(_VALHALLA_STAGES, start=1):
            if stage in text and idx > state["stage"]:
                state["stage"] = idx
                await emit(MapInstallProgress(
                    region_id=region_id, artifact="valhalla",
                    bytes_done=idx, bytes_total=total_stages,
                    phase="building_routing",
                ))
                return

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        bytes_done=0, bytes_total=total_stages,
        phase="building_routing",
    ))

    try:
        await _run_subprocess(
            cmd, tool="valhalla_build_tiles", on_line=_on_line,
            cancel_event=cancel_event,
        )
    except (asyncio.CancelledError, BuildFailed, BuildOutOfMemory):
        shutil.rmtree(scratch, ignore_errors=True)
        config_path.unlink(missing_ok=True)
        raise

    config_path.unlink(missing_ok=True)
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    scratch.replace(out_dir)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        bytes_done=total_stages, bytes_total=total_stages,
        phase="ready",
    ))


# ── Internals ─────────────────────────────────────────────────────

def _require_binary(name: str) -> str:
    """Return the absolute path to ``name``, or raise :class:`ToolchainMissing`."""
    path = shutil.which(name)
    if path is None:
        raise ToolchainMissing(
            f"{name} not on PATH — re-run ./run.sh --maps-tools-only",
        )
    return path


async def _run_subprocess(
    cmd: list[str],
    *,
    tool: str,
    on_line: Callable[[bytes], Awaitable[None]],
    cancel_event: asyncio.Event,
) -> None:
    """Run ``cmd``, stream combined stdout/stderr, honour ``cancel_event``.

    Raises :class:`asyncio.CancelledError` on cancel,
    :class:`BuildOutOfMemory` on OOM-style exit, or :class:`BuildFailed`
    on any other non-zero exit. The tail of stderr is preserved for
    the :class:`BuildFailed` message so the admin UI can surface *why*.
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    stderr_tail: list[bytes] = []
    _STDERR_TAIL_MAX = 10  # last N lines — enough to surface a root cause.

    async def _drain(stream: asyncio.StreamReader, is_stderr: bool) -> None:
        while True:
            line = await stream.readline()
            if not line:
                return
            if is_stderr:
                stderr_tail.append(line)
                if len(stderr_tail) > _STDERR_TAIL_MAX:
                    del stderr_tail[: len(stderr_tail) - _STDERR_TAIL_MAX]
            try:
                await on_line(line)
            except Exception:  # noqa: BLE001 — progress parsing must not kill build
                log.exception("progress callback raised; continuing build")

    async def _watch_cancel() -> None:
        while proc.returncode is None:
            if cancel_event.is_set():
                _terminate(proc)
                return
            await asyncio.sleep(0.1)

    drain_out = asyncio.create_task(_drain(proc.stdout, is_stderr=False))
    drain_err = asyncio.create_task(_drain(proc.stderr, is_stderr=True))
    canceller = asyncio.create_task(_watch_cancel())

    try:
        rc = await proc.wait()
    finally:
        canceller.cancel()
        await asyncio.gather(drain_out, drain_err, return_exceptions=True)
        try:
            await canceller
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass

    if cancel_event.is_set():
        raise asyncio.CancelledError()

    if rc == 0:
        return

    # Exit 137 = 128 + 9 (SIGKILL, usually OOM killer on linux).
    # On macOS, negative return codes denote the killing signal directly.
    if rc in (137, -9) or rc == -signal.SIGKILL:
        raise BuildOutOfMemory(
            f"{tool} killed by OS (exit {rc}); region likely exceeds device RAM",
        )

    last = _last_stderr_line(stderr_tail)
    raise BuildFailed(f"{tool} failed (exit {rc}): {last}" if last else f"{tool} failed (exit {rc})")


def _terminate(proc: asyncio.subprocess.Process) -> None:
    """Best-effort SIGTERM the subprocess. SIGKILL is the caller's fallback."""
    try:
        proc.terminate()
    except ProcessLookupError:
        pass


def _last_stderr_line(tail: list[bytes]) -> str:
    """Return the last non-blank stderr line, clamped to 200 chars."""
    for raw in reversed(tail):
        text = raw.decode("utf-8", errors="replace").strip()
        if text:
            return text[:200]
    return ""


__all__ = [
    "BuildFailed",
    "BuildOutOfMemory",
    "ToolchainMissing",
    "run_tippecanoe",
    "run_valhalla",
]
