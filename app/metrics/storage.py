"""Storage metrics helpers."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
OLLAMA_HOME_DIR = Path.home() / ".ollama"
OLLAMA_MODELS_DIR = OLLAMA_HOME_DIR / "models"
HAILO_SHARED_MODELS_DIR = Path("/usr/share/hailo-ollama/models")
HAILO_USER_MODELS_DIR = Path.home() / ".local" / "share" / "hailo-ollama" / "models"


def storage_buckets_payload(data_path: Path, profile: str) -> list[dict[str, Any]]:
    """Return storage usage buckets for the dashboard."""
    buckets = [
        storage_bucket("lokidoki_repo", "LokiDoki App", REPO_ROOT),
        storage_bucket("lokidoki_data", "LokiDoki Data", data_path),
        storage_bucket("ollama_home", "Ollama", OLLAMA_HOME_DIR),
        storage_bucket("ollama_models", "Ollama Models", OLLAMA_MODELS_DIR),
    ]
    if profile == "pi_hailo":
        buckets.extend(
            [
                storage_bucket("hailo_models_shared", "Hailo Shared Models", HAILO_SHARED_MODELS_DIR),
                storage_bucket("hailo_models_user", "Hailo User Models", HAILO_USER_MODELS_DIR),
            ]
        )
    return buckets


def storage_bucket(key: str, label: str, path: Path) -> dict[str, Any]:
    """Return one storage bucket payload."""
    exists = path.exists()
    size_bytes = directory_size_bytes(path) if exists else 0
    return {
        "key": key,
        "label": label,
        "path": str(path),
        "exists": exists,
        "size_bytes": size_bytes,
    }


def storage_total(storage: list[dict[str, Any]], keys: set[str]) -> int:
    """Return the total size of matching storage buckets."""
    return sum(int(item["size_bytes"]) for item in storage if item.get("key") in keys)


def directory_size_bytes(path: Path) -> int:
    """Return directory size in bytes."""
    try:
        result = subprocess.run(
            ["du", "-sk", str(path)],
            capture_output=True,
            check=True,
            text=True,
        )
        return int(result.stdout.split()[0]) * 1024
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        return _directory_size_bytes_fallback(path)


def _directory_size_bytes_fallback(path: Path) -> int:
    """Return directory size in bytes using Python traversal."""
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for child in path.rglob("*"):
        if not child.is_file():
            continue
        try:
            total += child.stat().st_size
        except OSError:
            continue
    return total
