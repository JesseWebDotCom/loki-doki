#!/usr/bin/env python3
"""Verify an offline bundle against its ``bundle_manifest.json``.

Exit 0 = every file listed in the manifest exists on disk and its
SHA-256 + byte size match. Exit 1 = the bundle is incomplete or
corrupt; the script prints a list of missing/mismatched files.

Usage::

    python3 scripts/verify_offline_bundle.py /media/usb/lokidoki-offline-bundle
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(bundle_dir: Path) -> list[str]:
    """Return a list of human-readable error strings; empty means OK."""
    manifest_path = bundle_dir / "bundle_manifest.json"
    if not manifest_path.is_file():
        return [f"missing manifest: {manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return [f"malformed manifest ({exc})"]

    errors: list[str] = []
    for entry in manifest.get("files", []):
        rel = entry.get("path")
        expected_sha = entry.get("sha256")
        expected_size = entry.get("size")
        if not isinstance(rel, str):
            errors.append(f"manifest entry missing 'path': {entry!r}")
            continue
        target = bundle_dir / rel
        if not target.is_file():
            errors.append(f"missing: {rel}")
            continue
        if isinstance(expected_size, int) and target.stat().st_size != expected_size:
            errors.append(
                f"size mismatch: {rel} (expected {expected_size}, "
                f"got {target.stat().st_size})"
            )
            continue
        if isinstance(expected_sha, str):
            actual = _sha256_file(target)
            if actual.lower() != expected_sha.lower():
                errors.append(
                    f"sha256 mismatch: {rel} (expected {expected_sha}, got {actual})"
                )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="verify_offline_bundle.py")
    parser.add_argument("bundle", type=Path, help="bundle directory to verify")
    args = parser.parse_args(argv)

    bundle_dir: Path = args.bundle.resolve()
    if not bundle_dir.is_dir():
        print(f"not a directory: {bundle_dir}", file=sys.stderr)
        return 1
    errors = verify(bundle_dir)
    if errors:
        print(f"bundle verification FAILED ({len(errors)} issue(s)):")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"bundle verified: {bundle_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
