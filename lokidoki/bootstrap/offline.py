"""Seed ``.lokidoki/`` from a sibling offline bundle directory.

When ``python -m lokidoki.bootstrap --offline-bundle=<path>`` is passed
(or a sibling ``lokidoki-offline-bundle/`` directory exists next to the
repo root), this module links the bundle's ``cache/`` and
``huggingface/`` trees into ``.lokidoki/`` before the pipeline starts.
Preflights short-circuit on on-disk SHA matches, so once the cache is
pre-seeded the wizard runs without network access.

Linking strategy:

* Unix (mac / linux / pi): symlink each file. Cheap, instant, and the
  bundle can live on read-only media (USB, SD) without copies.
* Windows: copy files. Filesystem symlinks on Windows require either
  Developer Mode or admin rights (``SeCreateSymbolicLinkPrivilege``)
  and silently become a user-visible .lnk on FAT media, so a plain
  copy is the only portable option.
"""
from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

_log = logging.getLogger(__name__)

DEFAULT_BUNDLE_DIRNAME = "lokidoki-offline-bundle"


def discover_bundle(
    explicit: Optional[Path],
    *,
    repo_root: Optional[Path] = None,
) -> Optional[Path]:
    """Return the bundle dir to use, or ``None`` if offline mode is off.

    Precedence: the ``--offline-bundle`` CLI value wins; otherwise look
    for a sibling ``lokidoki-offline-bundle/`` next to the repo root.
    """
    if explicit is not None:
        if not explicit.is_dir():
            raise FileNotFoundError(
                f"--offline-bundle={explicit} is not a directory"
            )
        return explicit.resolve()
    base = (repo_root or Path.cwd()).resolve()
    candidate = base / DEFAULT_BUNDLE_DIRNAME
    if candidate.is_dir():
        return candidate
    # Also check the parent (user may keep the bundle next to the clone).
    candidate = base.parent / DEFAULT_BUNDLE_DIRNAME
    if candidate.is_dir():
        return candidate
    return None


def _is_windows() -> bool:
    return os.name == "nt" or sys.platform == "win32"


def _link_one(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        return  # preflights validate by SHA, so a pre-existing file is fine
    if _is_windows():
        shutil.copy2(src, dest)
    else:
        try:
            dest.symlink_to(src)
        except OSError:
            # Filesystem refused symlinks (rare FAT/exFAT cases) — fall
            # back to a copy so the rest of the bundle still seeds.
            shutil.copy2(src, dest)


def _seed_tree(src_root: Path, dest_root: Path) -> int:
    """Link every file under ``src_root`` into the mirror under ``dest_root``."""
    if not src_root.is_dir():
        return 0
    linked = 0
    for src in src_root.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(src_root)
        _link_one(src, dest_root / rel)
        linked += 1
    return linked


def apply_bundle(bundle: Path, data_dir: Path) -> dict[str, int]:
    """Seed ``data_dir`` (``.lokidoki/``) from ``bundle``.

    Also sets ``HF_HOME`` to the bundle's ``huggingface/`` subdir so
    any in-process ``snapshot_download`` resolves from the bundle.

    Returns a summary ``{"cache": N, "huggingface": N}``.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, int] = {}
    summary["cache"] = _seed_tree(bundle / "cache", data_dir / "cache")
    bundle_hf = bundle / "huggingface"
    if bundle_hf.is_dir():
        summary["huggingface"] = _seed_tree(bundle_hf, data_dir / "huggingface")
        # Point the HF cache resolver at the bundle directly — snapshot_download
        # honours HF_HOME when materialising repos, and preflights set it on
        # their subprocess env too (``augmented_env`` copies os.environ).
        os.environ["HF_HOME"] = str((data_dir / "huggingface").resolve())
    else:
        summary["huggingface"] = 0
    _log.info(
        "offline bundle seeded: cache=%d huggingface=%d",
        summary["cache"],
        summary["huggingface"],
    )
    return summary


def reset_data_dir(data_dir: Path) -> None:
    """Delete ``.lokidoki/`` entirely — used by the ``--reset`` flag."""
    if data_dir.exists():
        shutil.rmtree(data_dir)


__all__ = [
    "DEFAULT_BUNDLE_DIRNAME",
    "apply_bundle",
    "discover_bundle",
    "reset_data_dir",
]
