"""Download pinned OpenAddresses ZIP bundles into ``data/maps/<region>/``.

This preflight is shared between bootstrap/offline-bundle flows and the
maps install pipeline. Each region pin is immutable and verified by size
plus SHA-256 before it is treated as ready on disk.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from ..context import StepContext
from ..events import StepLog
from ..versions import OPENADDRESSES_REGIONS


_STEP_PREFIX = "download-openaddresses-"
_CHUNK_SIZE = 1024 * 1024


async def ensure_openaddresses_for(region_id: str, ctx: StepContext) -> Path:
    """Ensure the pinned OpenAddresses ZIP for ``region_id`` exists on disk."""
    pin = OPENADDRESSES_REGIONS.get(region_id)
    if pin is None:
        raise RuntimeError(
            f"OpenAddresses region {region_id!r} is not pinned in "
            "lokidoki/bootstrap/versions.py::OPENADDRESSES_REGIONS. "
            "Add {url, sha256, size_bytes, filename} for this region first."
        )

    step_id = f"{_STEP_PREFIX}{region_id}"
    dest = _target_path(region_id, ctx, pin)
    if _matches_pin(dest, pin):
        ctx.emit(
            StepLog(
                step_id=step_id,
                line=(
                    f"openaddresses already present at {dest} "
                    f"({dest.stat().st_size} bytes)"
                ),
            )
        )
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    ctx.emit(
        StepLog(step_id=step_id, line=f"downloading openaddresses: {pin['url']}")
    )
    await ctx.download(
        str(pin["url"]),
        dest,
        step_id,
        sha256=str(pin["sha256"]),
    )
    _require_pin_match(dest, pin)
    ctx.emit(
        StepLog(
            step_id=step_id,
            line=(
                f"openaddresses ready at {dest} "
                f"({dest.stat().st_size} bytes)"
            ),
        )
    )
    return dest


def _target_path(
    region_id: str,
    ctx: StepContext,
    pin: dict[str, str | int],
) -> Path:
    return ctx.data_dir / "maps" / region_id / str(pin["filename"])


def _matches_pin(path: Path, pin: dict[str, str | int]) -> bool:
    if not path.is_file():
        return False
    if path.stat().st_size != int(pin["size_bytes"]):
        return False
    return _sha256_file(path) == str(pin["sha256"]).lower()


def _require_pin_match(path: Path, pin: dict[str, str | int]) -> None:
    actual_size = path.stat().st_size if path.exists() else 0
    expected_size = int(pin["size_bytes"])
    if actual_size != expected_size:
        path.unlink(missing_ok=True)
        raise RuntimeError(
            f"OpenAddresses size mismatch for {path.name}: expected "
            f"{expected_size}, got {actual_size}"
        )
    actual_sha = _sha256_file(path)
    expected_sha = str(pin["sha256"]).lower()
    if actual_sha != expected_sha:
        path.unlink(missing_ok=True)
        raise RuntimeError(
            f"OpenAddresses sha256 mismatch for {path.name}: expected "
            f"{expected_sha}, got {actual_sha}"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()
