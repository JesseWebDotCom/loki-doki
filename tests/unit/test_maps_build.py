"""Tests for :mod:`lokidoki.maps.build` — the planetiler + GraphHopper
async subprocess wrappers introduced by maps-local-build chunk 3.

The tests avoid the real binaries: they install tiny shell stubs on
``PATH`` via ``monkeypatch`` of ``shutil.which`` so the wrapper's
progress parsing, cancel path, and error classification can be
exercised end-to-end without a gigabyte download.

Unix-only: the stubs use ``/bin/sh``. Windows maps support is
explicitly unsupported in bootstrap today (see
``lokidoki/bootstrap/preflight/planetiler.py``) so the skip is safe.
"""
from __future__ import annotations

import asyncio
import platform
import textwrap

import pytest

from lokidoki.maps import build

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="build wrappers shell out via /bin/sh; Windows maps path isn't supported yet",
)


# ── Helpers ──────────────────────────────────────────────────────

def _install_stub(tmp_path, monkeypatch, name, script) -> None:
    """Write ``script`` into ``tmp_path/<name>`` and patch ``shutil.which``."""
    stub = tmp_path / name
    stub.write_text(script)
    stub.chmod(0o755)

    def _which(target, *, _name=name, _stub=stub):
        if target == _name:
            return str(_stub)
        return None

    monkeypatch.setattr(build.shutil, "which", _which)


def _patch_planetiler_paths(tmp_path, monkeypatch) -> None:
    tool_root = tmp_path / ".lokidoki" / "tools"
    jar_path = tool_root / "planetiler" / "planetiler.jar"
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    jar_path.write_bytes(b"fake-jar")
    sources_dir = tool_root / "planetiler" / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    def _fake_embedded(tool_dir: str, filename: str):
        return tool_root / tool_dir / filename

    monkeypatch.setattr(build, "_embedded_tool_path", _fake_embedded)


def _patch_graphhopper_paths(tmp_path, monkeypatch) -> None:
    tool_root = tmp_path / ".lokidoki" / "tools"
    jar_path = tool_root / "graphhopper" / "graphhopper.jar"
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    jar_path.write_bytes(b"fake-jar")

    def _fake_embedded(tool_dir: str, filename: str):
        return tool_root / tool_dir / filename

    monkeypatch.setattr(build, "_embedded_tool_path", _fake_embedded)


async def _collect():
    """Return an (events, emit) pair the wrappers can push into."""
    events: list = []

    async def emit(progress):
        events.append(progress)

    return events, emit


# ── _require_binary ───────────────────────────────────────────────

def test_require_binary_missing_raises(monkeypatch):
    monkeypatch.setattr(build.shutil, "which", lambda _name: None)
    with pytest.raises(build.ToolchainMissing) as info:
        build._require_binary("tippecanoe")
    # Error message must point users at the bootstrap flag.
    assert "--maps-tools-only" in str(info.value)


def test_require_binary_found_returns_path(monkeypatch):
    monkeypatch.setattr(
        build.shutil, "which",
        lambda _name: "/opt/tools/tippecanoe",
    )
    assert build._require_binary("tippecanoe") == "/opt/tools/tippecanoe"


def test_heap_mb_for_uses_env_override(monkeypatch):
    monkeypatch.setattr(build, "_runtime_profile", lambda: "mac")
    monkeypatch.setenv("LOKIDOKI_PLANETILER_HEAP_MB", "1536")
    assert build._heap_mb_for("LOKIDOKI_PLANETILER_HEAP_MB") == 1536


def test_heap_mb_for_falls_back_on_invalid_env(monkeypatch):
    monkeypatch.setattr(build, "_runtime_profile", lambda: "linux")
    monkeypatch.setenv("LOKIDOKI_GRAPHHOPPER_HEAP_MB", "nope")
    assert build._heap_mb_for("LOKIDOKI_GRAPHHOPPER_HEAP_MB") == 4096


# ── _run_subprocess primitives ────────────────────────────────────

def test_run_subprocess_streams_lines_to_callback():
    received: list[bytes] = []

    async def on_line(line):
        received.append(line)

    async def _run():
        await build._run_subprocess(
            ["sh", "-c", "echo hello; echo world"],
            tool="fake", on_line=on_line, cancel_event=asyncio.Event(),
        )

    asyncio.run(_run())
    joined = b"".join(received)
    assert b"hello" in joined
    assert b"world" in joined


def test_run_subprocess_cancel_terminates_and_raises(tmp_path):
    marker = tmp_path / "done.flag"

    async def _run():
        cancel = asyncio.Event()

        async def on_line(_line):
            # Flip cancel as soon as the subprocess produces anything.
            cancel.set()

        await build._run_subprocess(
            ["sh", "-c", f"echo start; sleep 5; touch {marker}"],
            tool="fake", on_line=on_line, cancel_event=cancel,
        )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run())
    # The sleep would have completed after 5s if SIGTERM didn't arrive.
    assert not marker.exists()


def test_run_subprocess_non_zero_raises_build_failed():
    async def on_line(_line):
        return None

    async def _run():
        await build._run_subprocess(
            ["sh", "-c", "echo 'boom: boundary' 1>&2; exit 7"],
            tool="fake", on_line=on_line, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.BuildFailed) as info:
        asyncio.run(_run())
    msg = str(info.value)
    assert "fake" in msg
    assert "7" in msg
    assert "boom" in msg  # last stderr line is surfaced.


def test_run_subprocess_oom_exit_raises_build_out_of_memory():
    async def on_line(_line):
        return None

    async def _run():
        await build._run_subprocess(
            ["sh", "-c", "exit 137"],
            tool="fake", on_line=on_line, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.BuildOutOfMemory):
        asyncio.run(_run())


# ── run_planetiler ────────────────────────────────────────────────

_PLANETILER_STUB = textwrap.dedent("""\
    #!/bin/sh
    OUT=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --output=*) OUT="${1#--output=}" ;;
        esac
        shift
    done
    echo "[main] osm_pass1 progress=10%"
    echo "[main] osm_pass2 progress=80%"
    echo "[main] archive progress=100%"
    if [ -n "$OUT" ]; then
        touch "$OUT"
    fi
""")


def test_run_planetiler_missing_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(build.shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        build,
        "_embedded_tool_path",
        lambda tool_dir, filename: tmp_path / ".missing-tools" / tool_dir / filename,
    )

    async def _run():
        _events, emit = await _collect()
        await build.run_planetiler(
            tmp_path / "foo.pbf", tmp_path / "out.pmtiles",
            region_id="us-ct", emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.ToolchainMissing):
        asyncio.run(_run())


def test_run_planetiler_emits_progress_and_writes_output(tmp_path, monkeypatch):
    _install_stub(tmp_path, monkeypatch, "java", _PLANETILER_STUB)
    _patch_planetiler_paths(tmp_path, monkeypatch)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out = tmp_path / "streets.pmtiles"

    events: list = []

    async def emit(progress):
        events.append(progress)

    async def _run():
        await build.run_planetiler(
            pbf, out, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    asyncio.run(_run())

    assert out.exists(), "planetiler stub should have produced the output"
    assert not out.with_suffix(out.suffix + ".partial").exists()
    # Opening + closing events.
    assert events[0].phase == "building_streets"
    assert events[0].bytes_done == 0
    assert events[-1].phase == "ready"
    assert events[-1].bytes_done == 100
    # Progress saw meaningful values in between.
    percents = [e.bytes_done for e in events if e.phase == "building_streets"]
    assert max(percents) >= 50


def test_run_planetiler_cmd_carries_download_dir_and_no_download(
    tmp_path, monkeypatch,
):
    """The planetiler command must point at the embedded sources dir
    via ``--download_dir`` and must NOT carry ``--download``. That
    combination is what keeps ``building_streets`` air-gapped.
    """
    _install_stub(tmp_path, monkeypatch, "java", _PLANETILER_STUB)
    _patch_planetiler_paths(tmp_path, monkeypatch)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out = tmp_path / "streets.pmtiles"

    captured_cmd: list[list[str]] = []

    async def _spy_run(cmd, *, tool, on_line, cancel_event):
        captured_cmd.append(list(cmd))
        # Simulate a successful no-op build so the caller completes.
        out_path = None
        for arg in cmd:
            if isinstance(arg, str) and arg.startswith("--output="):
                out_path = arg.split("=", 1)[1]
        if out_path:
            open(out_path, "wb").close()

    monkeypatch.setattr(build, "_run_subprocess", _spy_run)

    async def emit(_progress):
        return None

    async def _run():
        await build.run_planetiler(
            pbf, out, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    asyncio.run(_run())

    assert captured_cmd, "planetiler command never invoked"
    cmd = captured_cmd[0]
    sources_dir = tmp_path / ".lokidoki" / "tools" / "planetiler" / "sources"
    assert f"--natural_earth_path={sources_dir / 'natural_earth_vector.sqlite.zip'}" in cmd
    assert f"--water_polygons_path={sources_dir / 'water-polygons-split-3857.zip'}" in cmd
    # The bare ``--download`` flag must be gone and the command must not
    # contain any ``--download`` substring (``--download_dir`` included).
    assert "--download" not in cmd
    assert not any("--download" in a for a in cmd)


def test_run_planetiler_missing_sources_dir_raises(tmp_path, monkeypatch):
    """If the ``install-planetiler-data`` preflight never ran, the
    sources directory will not exist — refuse to start rather than
    silently fall back to an upstream fetch."""
    _install_stub(tmp_path, monkeypatch, "java", _PLANETILER_STUB)
    tool_root = tmp_path / ".lokidoki" / "tools"
    jar_path = tool_root / "planetiler" / "planetiler.jar"
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    jar_path.write_bytes(b"fake-jar")
    # Intentionally do NOT create the sources directory.

    def _fake_embedded(tool_dir: str, filename: str):
        return tool_root / tool_dir / filename

    monkeypatch.setattr(build, "_embedded_tool_path", _fake_embedded)

    async def emit(_progress):
        return None

    async def _run():
        await build.run_planetiler(
            tmp_path / "region.osm.pbf", tmp_path / "streets.pmtiles",
            region_id="us-ct", emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.ToolchainMissing):
        asyncio.run(_run())


def test_run_planetiler_cancel_cleans_partial(tmp_path, monkeypatch):
    script = textwrap.dedent("""\
        #!/bin/sh
        OUT=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --output=*) OUT="${1#--output=}" ;;
            esac
            shift
        done
        touch "$OUT"
        echo "[main] osm_pass1 progress=10%"
        sleep 5
        echo "done"
    """)
    _install_stub(tmp_path, monkeypatch, "java", script)
    _patch_planetiler_paths(tmp_path, monkeypatch)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out = tmp_path / "streets.pmtiles"

    async def _run():
        cancel = asyncio.Event()

        async def emit(_progress):
            # Flip cancel on the first progress event so the sleep in the
            # stub gets SIGTERM'd before it can complete.
            cancel.set()

        await build.run_planetiler(
            pbf, out, region_id="us-ct",
            emit=emit, cancel_event=cancel,
        )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run())

    assert not out.exists()
    assert not out.with_suffix(out.suffix + ".partial").exists()


# ── run_graphhopper_import ────────────────────────────────────────

_GRAPHHOPPER_STUB = textwrap.dedent("""\
    #!/bin/sh
    for last; do :; done
    CONFIG="$last"
    GRAPH_DIR="$(dirname "$CONFIG")/graph-cache"
    echo "INFO  c.g.reader.osm.DataReaderOSM - 25%"
    echo "INFO  c.g.storage.GraphStorage - 50%"
    echo "INFO  c.g.routing.ch.CHPreparation - 100%"
    mkdir -p "$GRAPH_DIR"
    echo "graph.bytes_for_flags: 8" > "$GRAPH_DIR/properties"
""")


def test_run_graphhopper_import_missing_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(build.shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        build,
        "_embedded_tool_path",
        lambda tool_dir, filename: tmp_path / ".missing-tools" / tool_dir / filename,
    )

    async def _run():
        _events, emit = await _collect()
        await build.run_graphhopper_import(
            tmp_path / "foo.pbf", tmp_path / "valhalla",
            region_id="us-ct", emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.ToolchainMissing):
        asyncio.run(_run())


def test_run_graphhopper_import_emits_progress_and_writes_tiles(tmp_path, monkeypatch):
    _install_stub(tmp_path, monkeypatch, "java", _GRAPHHOPPER_STUB)
    _patch_graphhopper_paths(tmp_path, monkeypatch)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out_dir = tmp_path / "valhalla"

    events: list = []

    async def emit(progress):
        events.append(progress)

    async def _run():
        await build.run_graphhopper_import(
            pbf, out_dir, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    asyncio.run(_run())

    assert out_dir.is_dir()
    assert (out_dir / "graph-cache" / "properties").exists()
    assert events[0].phase == "building_routing"
    assert events[-1].phase == "ready"
    percents = [e.bytes_done for e in events if e.phase == "building_routing"]
    assert max(percents) >= 60


def test_run_graphhopper_import_failed_exit_cleans_partial(tmp_path, monkeypatch):
    script = textwrap.dedent("""\
        #!/bin/sh
        echo "boom 1>&2" 1>&2
        exit 3
    """)
    _install_stub(tmp_path, monkeypatch, "java", script)
    _patch_graphhopper_paths(tmp_path, monkeypatch)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out_dir = tmp_path / "valhalla"

    async def _run():
        _events, emit = await _collect()
        await build.run_graphhopper_import(
            pbf, out_dir, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.BuildFailed):
        asyncio.run(_run())

    assert not out_dir.exists()
    assert not out_dir.with_suffix(".partial").exists()
