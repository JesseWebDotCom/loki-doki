"""Download + verify the pinned HEF (Hailo Executable Format) weight files.

HEFs are the compiled neural-net binaries the Hailo HAT loads at
runtime. Per-file sizes are 50-500 MB so we let the standard
:meth:`StepContext.download` stream them — it already emits a
:class:`StepProgress` event on every 1 MB chunk.

The ``required`` list is sourced from
``PLATFORM_MODELS["pi_hailo"]`` — only ``vision_model``,
``object_detector_model``, and ``face_detector_model`` values ending
in ``.hef`` qualify.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Iterable

from ..context import StepContext
from ..events import StepLog
from ..versions import HEF_FILES


_log = logging.getLogger(__name__)
_STEP_ID = "ensure-hef-files"


def hef_dir(ctx: StepContext) -> Path:
    """Return the on-disk root the HEFs are placed in."""
    return ctx.data_dir / "hef"


def required_hefs_for_profile(profile_models: dict) -> list[str]:
    """Filter ``profile_models`` for ``.hef`` filenames the wizard must fetch."""
    candidates = (
        profile_models.get("vision_model"),
        profile_models.get("object_detector_model"),
        profile_models.get("face_detector_model"),
    )
    return [c for c in candidates if isinstance(c, str) and c.endswith(".hef")]


async def ensure_hef_files(
    ctx: StepContext, required: Iterable[str] | None = None
) -> None:
    """Download every entry in ``required`` (or every HEF for ``ctx.profile``).

    Skips any file already present on disk with a matching SHA-256.
    Raises if a HEF filename is not pinned in
    :data:`lokidoki.bootstrap.versions.HEF_FILES`.
    """
    if required is None:
        required = _required_for_active_profile(ctx)
    required = list(required)
    if not required:
        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line="no HEF files required for this profile",
            )
        )
        return

    target_dir = hef_dir(ctx)
    target_dir.mkdir(parents=True, exist_ok=True)

    for name in required:
        if name not in HEF_FILES:
            raise RuntimeError(
                f"HEF {name!r} is not pinned in versions.HEF_FILES — "
                "add it before relying on this profile"
            )
        url, sha256, size_mb = HEF_FILES[name]
        dest = target_dir / name

        if dest.exists() and _sha256_matches(dest, sha256):
            ctx.emit(
                StepLog(
                    step_id=_STEP_ID,
                    line=f"{name} already present ({size_mb} MB) — skip",
                )
            )
            continue

        ctx.emit(
            StepLog(
                step_id=_STEP_ID,
                line=f"downloading {name} (~{size_mb} MB) from {url}",
            )
        )
        await ctx.download(url, dest, _STEP_ID, sha256=sha256)


def _required_for_active_profile(ctx: StepContext) -> list[str]:
    from lokidoki.core.platform import PLATFORM_MODELS

    return required_hefs_for_profile(PLATFORM_MODELS[ctx.profile])


def _sha256_matches(path: Path, expected: str) -> bool:
    """True when ``path``'s SHA-256 equals ``expected`` (case-insensitive)."""
    h = hashlib.sha256()
    try:
        with path.open("rb") as fp:
            for chunk in iter(lambda: fp.read(1024 * 1024), b""):
                h.update(chunk)
    except OSError:
        return False
    return h.hexdigest().lower() == expected.lower()


__all__ = [
    "ensure_hef_files",
    "required_hefs_for_profile",
    "hef_dir",
]
