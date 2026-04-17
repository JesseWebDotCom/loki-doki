"""System metrics: CPU, memory, disk, processes, storage buckets.

System metrics — consolidated into one
module since the helpers are small and share no mutable state.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


# ── helpers ──────────────────────────────────────────────────────

def _pct(used: int, total: int) -> float:
    return round((used / total) * 100.0, 1) if total > 0 else 0.0


def _sysctl_int(key: str) -> int:
    try:
        r = subprocess.run(["sysctl", "-n", key], capture_output=True, check=True, text=True)
        return int(r.stdout.strip())
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0


def _meminfo_bytes(line: str) -> int:
    try:
        return int(line.split(":", 1)[1].strip().split()[0]) * 1024
    except (IndexError, ValueError):
        return 0


# ── CPU ──────────────────────────────────────────────────────────

def cpu_load_percent() -> float:
    try:
        load_1m = os.getloadavg()[0]
    except (AttributeError, OSError):
        return 0.0
    return round(min((load_1m / max(os.cpu_count() or 1, 1)) * 100.0, 999.0), 1)


# ── memory ───────────────────────────────────────────────────────

def total_memory_bytes() -> int:
    if sys.platform == "darwin":
        return _sysctl_int("hw.memsize")
    mi = Path("/proc/meminfo")
    if mi.exists():
        for line in mi.read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                return _meminfo_bytes(line)
    return 0


def used_memory_bytes(total: int) -> int:
    if total <= 0:
        return 0
    if sys.platform == "darwin":
        return _darwin_used(total)
    mi = Path("/proc/meminfo")
    if mi.exists():
        vals: dict[str, int] = {}
        for line in mi.read_text(encoding="utf-8").splitlines():
            key = line.split(":", 1)[0]
            vals[key] = _meminfo_bytes(line)
        return max(total - vals.get("MemAvailable", 0), 0)
    return 0


def _darwin_used(total: int) -> int:
    try:
        r = subprocess.run(["vm_stat"], capture_output=True, check=True, text=True)
    except (OSError, subprocess.CalledProcessError):
        return 0
    page_size = 4096
    active = wired = compressed = 0
    for line in r.stdout.splitlines():
        s = line.strip()
        if "page size of" in s:
            try:
                page_size = int(s.split("page size of", 1)[1].split("bytes", 1)[0].strip())
            except (IndexError, ValueError):
                pass
        elif s.startswith("Pages active:"):
            active = _vm_pages(s)
        elif s.startswith("Pages wired down:"):
            wired = _vm_pages(s)
        elif s.startswith("Pages occupied by compressor:"):
            compressed = _vm_pages(s)
    return min(max((active + wired + compressed) * page_size, 0), total)


def _vm_pages(line: str) -> int:
    try:
        return int(line.split(":", 1)[1].strip().rstrip("."))
    except (IndexError, ValueError):
        return 0


# ── processes ────────────────────────────────────────────────────

def _ps_rows() -> list[dict[str, Any]]:
    try:
        r = subprocess.run(
            ["ps", "-axo", "pid=,comm=,%cpu=,rss=,args="],
            capture_output=True, check=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    rows: list[dict[str, Any]] = []
    for raw in r.stdout.splitlines():
        parts = raw.strip().split(None, 4)
        if len(parts) < 5:
            continue
        try:
            rows.append({
                "pid": int(parts[0]),
                "comm": parts[1],
                "cpu_percent": round(float(parts[2]), 1),
                "memory_bytes": int(parts[3]) * 1024,
                "command": parts[4].strip(),
            })
        except ValueError:
            continue
    return rows


def _match(rows: list[dict], predicate, label: str) -> dict[str, Any]:
    for row in rows:
        if predicate(row):
            return {
                "label": label, "running": True, "pid": row["pid"],
                "cpu_percent": row["cpu_percent"],
                "memory_bytes": row["memory_bytes"],
                "command": row["command"],
            }
    return {"label": label, "running": False, "pid": None,
            "cpu_percent": 0.0, "memory_bytes": 0, "command": ""}


def tracked_processes() -> list[dict[str, Any]]:
    rows = _ps_rows()
    pid = os.getpid()
    return [
        _match(rows, lambda r: r["pid"] == pid, "LokiDoki"),
        _match(rows, lambda r: "ollama" in Path(r["comm"]).name.lower()
               or "ollama serve" in r["command"].lower(), "Ollama"),
    ]


# ── storage ──────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[2]
OLLAMA_HOME = Path.home() / ".ollama"
OLLAMA_MODELS = OLLAMA_HOME / "models"


def _dir_size(path: Path) -> int:
    try:
        r = subprocess.run(["du", "-sk", str(path)], capture_output=True, check=True, text=True)
        return int(r.stdout.split()[0]) * 1024
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        if not path.exists():
            return 0
        total = 0
        for f in path.rglob("*"):
            if f.is_file():
                try:
                    total += f.stat().st_size
                except OSError:
                    pass
        return total


def _bucket(key: str, label: str, path: Path) -> dict[str, Any]:
    exists = path.exists()
    return {"key": key, "label": label, "path": str(path),
            "exists": exists, "size_bytes": _dir_size(path) if exists else 0}


def storage_buckets(data_dir: Path) -> list[dict[str, Any]]:
    return [
        _bucket("lokidoki_app", "LokiDoki App", REPO_ROOT),
        _bucket("lokidoki_data", "LokiDoki Data", data_dir),
        _bucket("zim_archives", "Knowledge Archives", data_dir / "archives"),
        _bucket("ollama_home", "Ollama", OLLAMA_HOME),
        _bucket("ollama_models", "Ollama Models", OLLAMA_MODELS),
    ]


# ── aggregate ────────────────────────────────────────────────────

def collect(data_dir: Path | None = None) -> dict[str, Any]:
    """Return the full metrics payload."""
    if data_dir is None:
        data_dir = Path("data")
    disk = shutil.disk_usage(data_dir if data_dir.exists() else Path("."))
    mem_total = total_memory_bytes()
    mem_used = used_memory_bytes(mem_total)
    return {
        "system": {
            "cpu": {"load_percent": cpu_load_percent(), "cores": os.cpu_count() or 1},
            "memory": {
                "used_bytes": mem_used, "total_bytes": mem_total,
                "used_percent": _pct(mem_used, mem_total),
            },
            "disk": {
                "used_bytes": disk.used, "total_bytes": disk.total,
                "used_percent": _pct(disk.used, disk.total),
                "path": str(data_dir),
            },
        },
        "processes": tracked_processes(),
        "storage": storage_buckets(data_dir),
    }
