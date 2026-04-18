"""Valhalla tile layout helpers + the escape-hatch local build path.

By default every region's routing tiles arrive prebuilt as a
``.tar.zst`` archive alongside ``streets.pmtiles`` (see Chunk 2). This
module's :func:`ensure_tiles` just validates that the extracted
``data/maps/<region>/valhalla/`` tree exists before the Valhalla
sidecar touches it.

:func:`build_tiles` is the *escape hatch* — a direct
``valhalla_build_tiles`` subprocess call for developers who installed
``.osm.pbf`` on disk and want to rebuild without going through the
CDN. It is gated behind :func:`allow_local_build`, which reads the
``LOKIDOKI_ALLOW_LOCAL_VALHALLA_BUILD`` env var. On Pi 5 (``pi_cpu``
/ ``pi_hailo``) the catalog further refuses builds for regions whose
``pi_local_build_ok`` flag is ``False`` — those OOM on 8 GB RAM.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
from pathlib import Path

from lokidoki.maps import catalog as _catalog
from lokidoki.maps import store
from lokidoki.maps.models import MapInstallProgress

log = logging.getLogger(__name__)

_ALLOW_LOCAL_BUILD_ENV = "LOKIDOKI_ALLOW_LOCAL_VALHALLA_BUILD"


def allow_local_build() -> bool:
    """Return True when the local-build escape hatch is enabled.

    Default is False because :mod:`lokidoki.maps.routing.valhalla`
    always prefers the prebuilt per-region tarball.
    """
    return os.environ.get(_ALLOW_LOCAL_BUILD_ENV, "").strip() in {
        "1", "true", "yes", "on",
    }


def tile_dir(region_id: str) -> Path:
    """Return the expected extracted tile directory for ``region_id``."""
    return store.region_dir(region_id) / "valhalla"


def ensure_tiles(region_id: str) -> Path:
    """Validate that Valhalla tiles exist on disk for ``region_id``.

    Returns the tile directory path. Raises :class:`FileNotFoundError`
    with a message specific enough for the SSE error channel to
    surface. Extraction (from the ``.tar.zst`` Chunk 2 downloads) is
    handled by :func:`extract_archive` on install; this function is
    purely read-side validation.
    """
    d = tile_dir(region_id)
    if not d.is_dir():
        raise FileNotFoundError(
            f"Valhalla tiles missing for {region_id}: expected {d}",
        )
    # Valhalla tile trees are a hash of directories named by tile_id.
    # A fully-extracted tree always contains at least one subdir; an
    # empty directory almost certainly means a failed extraction.
    if not any(d.iterdir()):
        raise FileNotFoundError(
            f"Valhalla tile dir {d} is empty — re-install the region",
        )
    return d


def extract_archive(archive_path: Path, dest_dir: Path) -> int:
    """Extract ``archive_path`` into ``dest_dir`` atomically.

    Supports ``.tar.zst`` and plain ``.tar``. Returns the total size
    of extracted files in bytes. Uses a ``.partial`` scratch dir and
    ``os.replace`` so an interrupted extraction never leaves a
    half-populated ``dest_dir``.
    """
    if not archive_path.is_file():
        raise FileNotFoundError(archive_path)
    dest_dir.parent.mkdir(parents=True, exist_ok=True)
    scratch = dest_dir.with_suffix(".partial")
    if scratch.exists():
        shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)

    import tarfile

    suffixes = {s.lower() for s in archive_path.suffixes}
    if ".zst" in suffixes:
        try:
            import zstandard  # type: ignore
        except ImportError as exc:  # pragma: no cover — bootstrap pins zstandard
            raise RuntimeError(
                "zstandard package required to extract .tar.zst valhalla tiles",
            ) from exc
        decompressor = zstandard.ZstdDecompressor()
        with archive_path.open("rb") as raw:
            with decompressor.stream_reader(raw) as stream:
                with tarfile.open(fileobj=stream, mode="r|") as tar:
                    _safe_extract(tar, scratch)
    else:
        with tarfile.open(archive_path, "r:*") as tar:
            _safe_extract(tar, scratch)

    if dest_dir.exists():
        shutil.rmtree(dest_dir, ignore_errors=True)
    os.replace(scratch, dest_dir)

    total = 0
    for path in dest_dir.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return total


def _safe_extract(tar, dest: Path) -> None:
    """Tarfile extract that refuses absolute / traversal paths."""
    dest_resolved = dest.resolve()
    for member in tar:
        member_path = (dest / member.name).resolve()
        try:
            member_path.relative_to(dest_resolved)
        except ValueError as exc:
            raise RuntimeError(
                f"refusing to extract outside {dest}: {member.name}",
            ) from exc
        tar.extract(member, dest)


# ── Escape-hatch local build ──────────────────────────────────────

async def build_tiles(
    region_id: str,
    pbf_path: Path,
    emit,
    cancel_event: asyncio.Event | None = None,
) -> Path:
    """Run ``valhalla_build_tiles`` against ``pbf_path``.

    Only callable when :func:`allow_local_build` returns True AND the
    region's ``pi_local_build_ok`` flag is True. Emits SSE progress
    events in the Chunk-2 shape so the admin panel surfaces the
    long-running operation the same way it surfaces downloads.
    """
    if not allow_local_build():
        raise RuntimeError(
            "local Valhalla tile build is disabled; set "
            f"{_ALLOW_LOCAL_BUILD_ENV}=1 to enable.",
        )
    region = _catalog.get_region(region_id)
    if region is None:
        raise KeyError(region_id)
    if not region.pi_local_build_ok:
        raise RuntimeError(
            f"region {region_id} is too large for on-device tile build "
            "(install the prebuilt tiles instead).",
        )
    if shutil.which("valhalla_build_tiles") is None:
        raise RuntimeError(
            "valhalla_build_tiles not on PATH — install the runtime tarball",
        )

    dest = tile_dir(region_id)
    dest.mkdir(parents=True, exist_ok=True)
    config_path = dest.parent / "valhalla-build-config.json"
    _write_build_config(config_path, dest)

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        phase="building",
    ))

    cmd = [
        "valhalla_build_tiles",
        "-c", str(config_path),
        str(pbf_path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await proc.communicate()
    except asyncio.CancelledError:
        proc.kill()
        raise
    if proc.returncode != 0:
        raise RuntimeError(
            f"valhalla_build_tiles failed ({proc.returncode}): "
            f"{(stderr or b'').decode(errors='replace')[:500]}",
        )

    if cancel_event is not None and cancel_event.is_set():
        raise asyncio.CancelledError()

    await emit(MapInstallProgress(
        region_id=region_id, artifact="valhalla",
        phase="ready",
    ))
    return dest


def _write_build_config(config_path: Path, tile_dir_: Path) -> None:
    """Emit the JSON config ``valhalla_build_tiles`` consumes."""
    import json as _json

    payload = {
        "mjolnir": {
            "tile_dir": str(tile_dir_),
            "concurrency": 1,
        },
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(_json.dumps(payload, indent=2), encoding="utf-8")


__all__ = [
    "allow_local_build",
    "build_tiles",
    "ensure_tiles",
    "extract_archive",
    "tile_dir",
]
