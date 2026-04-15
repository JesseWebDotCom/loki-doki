#!/usr/bin/env python3
"""Build an offline bundle of every pinned artifact + HF snapshot.

The resulting directory is what the operator copies next to the repo
clone on an air-gapped target host. The ``--offline-bundle=<path>`` flag
on ``python -m lokidoki.bootstrap`` (see
:mod:`lokidoki.bootstrap.offline`) seeds ``.lokidoki/cache/`` from this
directory so the pipeline never touches the network.

Layout::

    <output>/
        cache/<filename>               # every pinned tarball/zip/onnx/hef
        huggingface/<repo_id>/...      # HF snapshots for the selected profile(s)
        bundle_manifest.json           # sha256 + byte size for every file

Usage::

    python3 scripts/build_offline_bundle.py --profile=mac \
        --output=/media/usb/lokidoki-offline-bundle
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lokidoki.bootstrap import versions as V  # noqa: E402
from lokidoki.core.platform import PLATFORM_MODELS  # noqa: E402

_log = logging.getLogger("build_offline_bundle")

PROFILE_OS_ARCH: dict[str, tuple[str, str]] = {
    "mac": ("darwin", "arm64"),
    "windows": ("windows", "x86_64"),
    "linux": ("linux", "x86_64"),
    "pi_cpu": ("linux", "aarch64"),
    "pi_hailo": ("linux", "aarch64"),
}


class FetchSpec:
    """One (url, dest, sha256) record queued for download."""

    __slots__ = ("url", "dest", "sha256", "label")

    def __init__(self, url: str, dest: Path, sha256: str | None, label: str) -> None:
        self.url = url
        self.dest = dest
        self.sha256 = sha256
        self.label = label


def _resolve_profiles(profile_arg: str) -> list[str]:
    if profile_arg == "all":
        return list(PLATFORM_MODELS.keys())
    if profile_arg not in PLATFORM_MODELS:
        raise SystemExit(
            f"unknown profile {profile_arg!r}; expected one of "
            f"{sorted(PLATFORM_MODELS)} or 'all'"
        )
    return [profile_arg]


def _pinned_fetch_specs(profiles: Iterable[str], cache: Path) -> list[FetchSpec]:
    """Build the list of binary artifacts to fetch for ``profiles``."""
    profiles = list(profiles)
    os_arches = {PROFILE_OS_ARCH[p] for p in profiles}
    specs: list[FetchSpec] = []

    def _push_tpl(container: dict, label: str, *, key: tuple[str, str]) -> None:
        artifacts = container["artifacts"]
        if key not in artifacts:
            return
        filename, sha = artifacts[key]
        tpl = container["url_template"]
        fmt_kwargs: dict[str, str] = {"filename": filename}
        if "version" in container:
            fmt_kwargs["version"] = container["version"]
        if "tag" in container:
            fmt_kwargs["tag"] = container["tag"]
        url = tpl.format(**fmt_kwargs)
        specs.append(FetchSpec(url=url, dest=cache / filename, sha256=sha, label=label))

    # Always-needed toolchain (python, uv, node, piper) — once per os/arch.
    for key in os_arches:
        _push_tpl(V.PYTHON_BUILD_STANDALONE, "python", key=key)
        _push_tpl(V.UV, "uv", key=key)
        _push_tpl(V.NODE, "node", key=key)
        _push_tpl(V.PIPER, "piper", key=key)

    # Engine binaries: llama.cpp ships prebuilt on win/linux/pi_cpu; mac uses
    # MLX (pip package, no prebuilt); pi_hailo uses hailo-ollama.
    for profile in profiles:
        key = PROFILE_OS_ARCH[profile]
        engine = PLATFORM_MODELS[profile]["llm_engine"]
        if engine in ("llama_cpp_vulkan", "llama_cpp_cpu"):
            _push_tpl(V.LLAMA_CPP, "llama.cpp", key=key)
        elif engine == "hailo_ollama":
            _push_tpl(V.HAILO_OLLAMA, "hailo-ollama", key=key)

    # Piper voices (per-profile).
    for profile in profiles:
        voice = PLATFORM_MODELS[profile]["tts_voice"]
        entries = V.PIPER_VOICES.get(voice)
        if entries is None:
            continue
        for kind, (url, sha) in entries.items():
            fname = url.rsplit("/", 1)[-1]
            specs.append(
                FetchSpec(url=url, dest=cache / fname, sha256=sha, label=f"piper-voice-{kind}")
            )

    # Whisper.cpp GGML weights (only profiles that use whisper.cpp).
    for profile in profiles:
        stt = PLATFORM_MODELS[profile]["stt_model"]
        if not stt.startswith("whisper.cpp "):
            continue
        if stt not in V.WHISPER:
            continue
        url, sha = V.WHISPER[stt]
        fname = url.rsplit("/", 1)[-1]
        specs.append(FetchSpec(url=url, dest=cache / fname, sha256=sha, label="whisper"))

    # HEF files (pi_hailo only).
    if "pi_hailo" in profiles:
        hailo_models = PLATFORM_MODELS["pi_hailo"]
        hef_names = {
            hailo_models.get(k)
            for k in ("vision_model", "object_detector_model", "face_detector_model")
            if isinstance(hailo_models.get(k), str)
            and hailo_models[k].endswith(".hef")
        }
        for name in sorted(hef_names):
            if name not in V.HEF_FILES:
                continue
            url, sha, _mb = V.HEF_FILES[name]
            specs.append(FetchSpec(url=url, dest=cache / name, sha256=sha, label=f"hef:{name}"))

    # De-duplicate by destination path — mac and linux share some voices etc.
    seen: dict[Path, FetchSpec] = {}
    for spec in specs:
        seen.setdefault(spec.dest, spec)
    return list(seen.values())


def _hf_snapshots(profiles: Iterable[str]) -> list[str]:
    """Return the HF repo slugs whose snapshots must be downloaded."""
    slugs: set[str] = set()
    for profile in profiles:
        models = PLATFORM_MODELS[profile]
        for key in ("llm_fast", "llm_thinking", "vision_model"):
            value = models.get(key)
            if not isinstance(value, str):
                continue
            if value.endswith(".hef"):
                continue  # HEFs are plain downloads above
            if ":" in value:
                value = value.split(":", 1)[0]
            if "@" in value:
                value = value.split("@", 1)[0]
            if "/" in value:  # HF repo slugs always have a "/"
                slugs.add(value)
    return sorted(slugs)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(spec: FetchSpec) -> None:
    """Stream ``spec.url`` into ``spec.dest`` and verify the pinned SHA."""
    if not spec.url.startswith("https://"):
        raise RuntimeError(f"non-https url refused: {spec.url}")
    spec.dest.parent.mkdir(parents=True, exist_ok=True)
    if spec.dest.exists() and spec.sha256 and _sha256_file(spec.dest) == spec.sha256:
        _log.info("cache hit: %s", spec.dest.name)
        return
    import ssl
    import urllib.request

    part = spec.dest.with_name(spec.dest.name + ".part")
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        spec.url, headers={"User-Agent": "LokiDoki-OfflineBundle/0.1"}
    )
    _log.info("fetch: %s → %s", spec.url, spec.dest)
    h = hashlib.sha256()
    with urllib.request.urlopen(req, context=ctx) as resp, part.open("wb") as fp:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            fp.write(chunk)
            h.update(chunk)
    digest = h.hexdigest()
    if spec.sha256 and digest.lower() != spec.sha256.lower():
        part.unlink(missing_ok=True)
        raise RuntimeError(
            f"sha256 mismatch for {spec.url}: expected {spec.sha256}, got {digest}"
        )
    if spec.dest.exists():
        spec.dest.unlink()
    part.replace(spec.dest)


def _snapshot_hf(repo_id: str, hf_dir: Path) -> Path:
    """Download a HF repo snapshot into ``<hf_dir>/<repo_id>/``."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise SystemExit(
            "huggingface_hub is required for HF snapshots — "
            "install it with `pip install huggingface_hub` in the env "
            "you are running this script from."
        ) from exc
    local_dir = hf_dir / repo_id
    local_dir.mkdir(parents=True, exist_ok=True)
    _log.info("hf snapshot: %s → %s", repo_id, local_dir)
    snapshot_download(repo_id=repo_id, local_dir=str(local_dir))
    return local_dir


def _write_manifest(output: Path, profiles: list[str]) -> Path:
    """Walk the bundle and record sha256 + size for every file."""
    manifest: dict = {
        "schema": 1,
        "profiles": profiles,
        "files": [],
    }
    for path in sorted(output.rglob("*")):
        if path.is_dir():
            continue
        if path.name == "bundle_manifest.json":
            continue
        if path.name.endswith(".part"):
            continue
        rel = path.relative_to(output).as_posix()
        manifest["files"].append(
            {
                "path": rel,
                "sha256": _sha256_file(path),
                "size": path.stat().st_size,
            }
        )
    dest = output / "bundle_manifest.json"
    dest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="build_offline_bundle.py")
    parser.add_argument(
        "--profile",
        default="all",
        help="profile to bundle ('mac', 'windows', 'linux', 'pi_cpu', 'pi_hailo', or 'all')",
    )
    parser.add_argument(
        "--output",
        default="./lokidoki-offline-bundle",
        type=Path,
        help="directory to write the bundle into (default: ./lokidoki-offline-bundle)",
    )
    parser.add_argument(
        "--skip-hf",
        action="store_true",
        help="skip HF snapshot downloads (artifacts-only bundle)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="delete the output dir before rebuilding",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    profiles = _resolve_profiles(args.profile)
    output: Path = args.output.resolve()
    if args.clean and output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    cache = output / "cache"
    hf_dir = output / "huggingface"
    cache.mkdir(parents=True, exist_ok=True)
    hf_dir.mkdir(parents=True, exist_ok=True)

    specs = _pinned_fetch_specs(profiles, cache)
    _log.info("bundle profiles=%s artifacts=%d", profiles, len(specs))
    skipped_zero_sha: list[str] = []
    for spec in specs:
        if spec.sha256 and set(spec.sha256) == {"0"}:
            # Placeholder SHA (e.g. hailo-ollama pre-release) — the upstream
            # URL is not yet a usable download. Skip so the bundle can still
            # be built for other profiles without failing the whole run.
            _log.warning("skipping %s (placeholder sha256)", spec.dest.name)
            skipped_zero_sha.append(spec.dest.name)
            continue
        _download(spec)

    if not args.skip_hf:
        for repo_id in _hf_snapshots(profiles):
            _snapshot_hf(repo_id, hf_dir)

    manifest_path = _write_manifest(output, profiles)
    _log.info("manifest written: %s", manifest_path)
    if skipped_zero_sha:
        _log.warning(
            "skipped %d placeholder artifact(s): %s",
            len(skipped_zero_sha),
            ", ".join(skipped_zero_sha),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
