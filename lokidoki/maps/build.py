"""Async subprocess wrappers for local PMTiles + GraphHopper builds.

Chunk 3 of the maps-local-build plan: no remote CDN. Once a region's
``.osm.pbf`` has landed on disk, :func:`run_planetiler` turns it into
``streets.pmtiles`` and :func:`run_graphhopper_import` turns it into the
local routing graph under ``valhalla/graph-cache``.

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
import logging
import os
import platform
import re
import shutil
import signal
from pathlib import Path
from typing import Awaitable, Callable

from lokidoki.core.platform import UnsupportedPlatform, detect_profile

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

_PLANETILER_PHASES: dict[str, tuple[int, int]] = {
    "osm_pass1": (0, 30),
    "osm_pass2": (30, 70),
    "archive": (70, 100),
}
_PLANETILER_PROGRESS = re.compile(
    r"(?P<phase>osm_pass1|osm_pass2|archive).*progress=(?P<pct>\d{1,3})%",
    re.IGNORECASE,
)
_PLANETILER_OOM = "Exception in thread \"main\" java.lang.OutOfMemoryError"
_PLANETILER_HEAP_MB: dict[str, int] = {
    "pi_cpu": 2048,
    "pi_hailo": 2048,
    "mac": 6144,
    "linux": 4096,
    "windows": 4096,
}
_PLANETILER_HEAP_ENV = "LOKIDOKI_PLANETILER_HEAP_MB"
_GRAPHHOPPER_HEAP_ENV = "LOKIDOKI_GRAPHHOPPER_HEAP_MB"

_GRAPHHOPPER_PHASES: dict[str, tuple[int, int]] = {
    "datareaderosm": (0, 40),
    "graphstorage": (40, 80),
    "chpreparation": (80, 100),
}
_GRAPHHOPPER_LOG = re.compile(
    r"INFO\s+.*?(DataReaderOSM|GraphStorage|CHPreparation).*?(?:(\d{1,3})%)?",
    re.IGNORECASE,
)


# ── Public entry points ───────────────────────────────────────────

async def run_planetiler(
    pbf: Path,
    out_pmtiles: Path,
    *,
    region_id: str,
    emit: _EmitFn,
    cancel_event: asyncio.Event,
) -> None:
    """Build ``streets.pmtiles`` from ``pbf`` via planetiler."""
    java_bin = _resolve_java_binary()
    jar_path = _require_file(
        _embedded_tool_path("planetiler", "planetiler.jar"),
        label="planetiler.jar",
    )
    sources_dir = _require_dir(
        _embedded_tool_path("planetiler", "sources"),
        label="planetiler sources",
    )
    heap_mb = _heap_mb_for(_PLANETILER_HEAP_ENV)

    out_pmtiles.parent.mkdir(parents=True, exist_ok=True)
    scratch = out_pmtiles.with_name(f"{out_pmtiles.stem}.partial{out_pmtiles.suffix}")
    if scratch.exists():
        scratch.unlink()

    # Point each source-file arg at the pre-seeded ``sources_dir`` so
    # planetiler reads them locally instead of fetching from upstream.
    natural_earth = sources_dir / "natural_earth_vector.sqlite.zip"
    water_polygons = sources_dir / "water-polygons-split-3857.zip"
    cmd = [
        java_bin,
        f"-Xmx{heap_mb}m",
        "-jar",
        str(jar_path),
        f"--osm-path={pbf}",
        f"--output={scratch}",
        f"--natural_earth_path={natural_earth}",
        f"--water_polygons_path={water_polygons}",
        "--force",
    ]

    async def _on_line(line: bytes) -> None:
        text = line.decode("utf-8", errors="replace")
        match = _PLANETILER_PROGRESS.search(text)
        if match is None:
            return
        try:
            phase = match.group("phase").lower()
            raw_pct = int(match.group("pct"))
        except ValueError:  # pragma: no cover — regex guarantees digits
            return
        start, end = _PLANETILER_PHASES[phase]
        pct = start + int((max(0, min(100, raw_pct)) / 100) * (end - start))
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
            cmd, tool="planetiler", on_line=_on_line,
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


async def run_graphhopper_import(
    pbf: Path,
    out_dir: Path,
    *,
    region_id: str,
    emit: _EmitFn,
    cancel_event: asyncio.Event,
) -> None:
    """Build the GraphHopper routing graph under ``out_dir`` from ``pbf``."""
    java_bin = _resolve_java_binary()
    jar_path = _require_file(
        _embedded_tool_path("graphhopper", "graphhopper.jar"),
        label="graphhopper.jar",
    )
    heap_mb = _heap_mb_for(_GRAPHHOPPER_HEAP_ENV)
    scratch = out_dir.with_suffix(".partial")
    if scratch.exists():
        shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True, exist_ok=True)

    config_path = scratch / "graphhopper-config.yml"
    _write_graphhopper_config(
        config_path=config_path,
        pbf_path=pbf,
        graph_cache_dir=scratch / "graph-cache",
    )

    cmd = [
        java_bin,
        f"-Xmx{heap_mb}m",
        "-jar",
        str(jar_path),
        "import",
        str(config_path),
    ]

    state = {"pct": 0}

    async def _on_line(line: bytes) -> None:
        pct = _parse_graphhopper_progress(line.decode("utf-8", errors="replace"))
        if pct <= state["pct"]:
            return
        state["pct"] = pct
        await emit(MapInstallProgress(
            region_id=region_id, artifact="valhalla",
            bytes_done=pct, bytes_total=100,
            phase="building_routing",
        ))

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        bytes_done=0, bytes_total=100,
        phase="building_routing",
    ))

    try:
        await _run_subprocess(
            cmd, tool="graphhopper", on_line=_on_line,
            cancel_event=cancel_event,
        )
    except (asyncio.CancelledError, BuildFailed, BuildOutOfMemory):
        shutil.rmtree(scratch, ignore_errors=True)
        raise

    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    scratch.replace(out_dir)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        bytes_done=100, bytes_total=100,
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


def _require_file(path: Path, *, label: str) -> Path:
    if not path.is_file():
        raise ToolchainMissing(
            f"{label} not available — re-run ./run.sh --maps-tools-only",
        )
    return path


def _require_dir(path: Path, *, label: str) -> Path:
    if not path.is_dir():
        raise ToolchainMissing(
            f"{label} not available — re-run ./run.sh --maps-tools-only",
        )
    return path


def _embedded_tool_path(tool_dir: str, filename: str) -> Path:
    return Path(".lokidoki") / "tools" / tool_dir / filename


def _resolve_java_binary() -> str:
    embedded = _embedded_tool_path("jre/bin", "java.exe" if os.name == "nt" else "java")
    if embedded.is_file():
        return str(embedded.resolve())
    return _require_binary("java")


def _write_graphhopper_config(
    *,
    config_path: Path,
    pbf_path: Path,
    graph_cache_dir: Path,
) -> None:
    template_path = Path(__file__).parent / "routing" / "graphhopper_config_template.yml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        template_path.read_text(encoding="utf-8").format(
            pbf_path=str(pbf_path),
            graph_cache_dir=str(graph_cache_dir),
        ),
        encoding="utf-8",
    )


def _parse_graphhopper_progress(text: str) -> int:
    match = _GRAPHHOPPER_LOG.search(text)
    if match is None:
        return 0
    phase = match.group(1).lower()
    start, end = _GRAPHHOPPER_PHASES.get(phase, (0, 0))
    raw = match.group(2)
    if raw is None:
        return start
    try:
        raw_pct = max(0, min(100, int(raw)))
    except ValueError:
        return start
    return start + int((raw_pct / 100) * (end - start))


def _runtime_profile() -> str:
    try:
        return detect_profile()
    except UnsupportedPlatform:
        pass
    system = platform.system()
    if system == "Windows":
        return "windows"
    if system == "Darwin":
        return "mac"
    return "linux"


def _heap_mb_for(env_var: str) -> int:
    """Return the Java heap size for the current profile, honoring env overrides."""
    raw = os.environ.get(env_var, "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            log.warning("ignoring invalid %s=%r", env_var, raw)
        else:
            if value > 0:
                return value
            log.warning("ignoring non-positive %s=%r", env_var, raw)
    return _PLANETILER_HEAP_MB[_runtime_profile()]


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
    stderr_text: list[str] = []
    _STDERR_TAIL_MAX = 10  # last N lines — enough to surface a root cause.

    async def _drain(stream: asyncio.StreamReader, is_stderr: bool) -> None:
        while True:
            line = await stream.readline()
            if not line:
                return
            if is_stderr:
                stderr_tail.append(line)
                stderr_text.append(line.decode("utf-8", errors="replace"))
                if len(stderr_tail) > _STDERR_TAIL_MAX:
                    del stderr_tail[: len(stderr_tail) - _STDERR_TAIL_MAX]
                if len(stderr_text) > _STDERR_TAIL_MAX:
                    del stderr_text[: len(stderr_text) - _STDERR_TAIL_MAX]
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
    if any(_PLANETILER_OOM in line for line in stderr_text):
        raise BuildOutOfMemory(
            f"{tool} ran out of memory; region likely exceeds device RAM",
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
    "run_graphhopper_import",
    "run_planetiler",
]
