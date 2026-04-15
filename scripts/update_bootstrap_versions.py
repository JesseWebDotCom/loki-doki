"""Refresh pinned SHA-256 digests in ``lokidoki/bootstrap/versions.py``.

Run manually when bumping python-build-standalone or uv. Fetches the
current release metadata from GitHub, matches each artifact name in
``versions.py`` against the release's assets, and prints an updated
block the maintainer can paste back into the file.

Never writes the file itself — the intent is a reviewable diff, not a
cron job. Requires only stdlib ``urllib`` (same floor as Layer 1).
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from typing import Any

from lokidoki.bootstrap.versions import PYTHON_BUILD_STANDALONE, UV


_GH_API = "https://api.github.com/repos/{repo}/releases/tags/{tag}"
_GH_LATEST = "https://api.github.com/repos/{repo}/releases/latest"


def _fetch(url: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url, headers={"User-Agent": "LokiDoki-VersionBump"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def _paginated_assets(repo: str, release_id: int) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    page = 1
    while True:
        url = (
            f"https://api.github.com/repos/{repo}/releases/"
            f"{release_id}/assets?per_page=100&page={page}"
        )
        batch = _fetch(url)
        if not isinstance(batch, list) or not batch:
            break
        assets.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return assets


def _by_name(assets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {a["name"]: a for a in assets}


def _digest(asset: dict[str, Any]) -> str:
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        return digest[len("sha256:"):]
    return ""


def refresh_python_build_standalone() -> None:
    repo = "astral-sh/python-build-standalone"
    tag = PYTHON_BUILD_STANDALONE["tag"]
    release = _fetch(_GH_API.format(repo=repo, tag=tag))
    assets = _by_name(_paginated_assets(repo, release["id"]))
    print(f"# python-build-standalone {tag}")
    for key, (filename, _) in PYTHON_BUILD_STANDALONE["artifacts"].items():
        asset = assets.get(filename)
        sha = _digest(asset) if asset else "<missing>"
        print(f"{key}: {filename}  {sha}")


def refresh_uv() -> None:
    repo = "astral-sh/uv"
    version = UV["version"]
    release = _fetch(_GH_API.format(repo=repo, tag=version))
    assets = _by_name(release.get("assets", []))
    print(f"# uv {version}")
    for key, (filename, _) in UV["artifacts"].items():
        asset = assets.get(filename)
        sha = _digest(asset) if asset else "<missing>"
        print(f"{key}: {filename}  {sha}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--only",
        choices=["pbs", "uv"],
        help="Refresh just one table. Default is both.",
    )
    args = parser.parse_args(argv)
    if args.only in (None, "pbs"):
        refresh_python_build_standalone()
    if args.only in (None, "uv"):
        refresh_uv()
    return 0


if __name__ == "__main__":
    sys.exit(main())
