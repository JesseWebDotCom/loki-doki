"""Tests for :mod:`lokidoki.maps.build` — the planetiler + valhalla
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


# ── run_valhalla ──────────────────────────────────────────────────

_VALHALLA_STUB = textwrap.dedent("""\
    #!/bin/sh
    # Ignore all args; emit a few stage-like markers and a tile file.
    CONFIG=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -c) shift; CONFIG="$1" ;;
        esac
        shift
    done
    echo "parse stage beginning"
    echo "construct phase running"
    echo "cleanup done"
    # Pull the tile dir out of the minimal JSON config the wrapper wrote.
    TILE_DIR=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['mjolnir']['tile_dir'])" "$CONFIG")
    mkdir -p "$TILE_DIR/0"
    echo tile > "$TILE_DIR/0/0.gph"
""")


def test_run_valhalla_missing_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(build.shutil, "which", lambda _name: None)

    async def _run():
        _events, emit = await _collect()
        await build.run_valhalla(
            tmp_path / "foo.pbf", tmp_path / "valhalla",
            region_id="us-ct", emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.ToolchainMissing):
        asyncio.run(_run())


def test_run_valhalla_emits_stage_progress_and_writes_tiles(tmp_path, monkeypatch):
    _install_stub(tmp_path, monkeypatch, "valhalla_build_tiles", _VALHALLA_STUB)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out_dir = tmp_path / "valhalla"

    events: list = []

    async def emit(progress):
        events.append(progress)

    async def _run():
        await build.run_valhalla(
            pbf, out_dir, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    asyncio.run(_run())

    assert out_dir.is_dir()
    assert any(out_dir.rglob("*.gph"))
    assert events[0].phase == "building_routing"
    assert events[-1].phase == "ready"
    # Saw at least two of the three stages in the stub output.
    stages_seen = [e.bytes_done for e in events if e.phase == "building_routing"]
    assert max(stages_seen) >= 2


def test_run_valhalla_failed_exit_cleans_partial(tmp_path, monkeypatch):
    script = textwrap.dedent("""\
        #!/bin/sh
        echo "boom 1>&2" 1>&2
        exit 3
    """)
    _install_stub(tmp_path, monkeypatch, "valhalla_build_tiles", script)
    pbf = tmp_path / "region.osm.pbf"
    pbf.write_text("unused")
    out_dir = tmp_path / "valhalla"

    async def _run():
        _events, emit = await _collect()
        await build.run_valhalla(
            pbf, out_dir, region_id="us-ct",
            emit=emit, cancel_event=asyncio.Event(),
        )

    with pytest.raises(build.BuildFailed):
        asyncio.run(_run())

    assert not out_dir.exists()
    assert not out_dir.with_suffix(".partial").exists()
