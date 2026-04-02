"""Platform-specific system metrics helpers."""

from __future__ import annotations

import os
from pathlib import Path
import sys


def cpu_load_percent() -> float:
    """Return a load-based CPU percentage."""
    try:
        load_1m = os.getloadavg()[0]
    except (AttributeError, OSError):
        return 0.0
    cpu_count = max(os.cpu_count() or 1, 1)
    return round(min((load_1m / cpu_count) * 100.0, 999.0), 1)


def total_memory_bytes() -> int:
    """Return total system memory in bytes."""
    if sys.platform == "darwin":
        return _sysctl_int("hw.memsize")
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            if not line.startswith("MemTotal:"):
                continue
            return _meminfo_line_bytes(line)
    return 0


def used_memory_bytes(total_bytes: int) -> int:
    """Return used system memory in bytes."""
    if total_bytes <= 0:
        return 0
    if sys.platform == "darwin":
        return _darwin_used_memory_bytes(total_bytes)
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        values: dict[str, int] = {}
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            key, _, _value = line.partition(":")
            values[key] = _meminfo_line_bytes(line)
        available = values.get("MemAvailable", 0)
        return max(total_bytes - available, 0)
    return 0


def calculate_percent(used: int, total: int) -> float:
    """Return a rounded percentage."""
    if total <= 0:
        return 0.0
    return round((used / total) * 100.0, 1)


def _darwin_used_memory_bytes(total_bytes: int) -> int:
    """Return approximate used memory bytes on macOS."""
    import subprocess
    try:
        vm_stat = subprocess.run(
            ["vm_stat"],
            capture_output=True,
            check=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return 0
    page_size = 4096
    active_pages = 0
    wired_pages = 0
    compressed_pages = 0
    for line in vm_stat.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("Mach Virtual Memory Statistics:"):
            continue
        if "page size of" in stripped:
            try:
                page_size = int(stripped.split("page size of", 1)[1].split("bytes", 1)[0].strip())
            except (IndexError, ValueError):
                page_size = 4096
            continue
        if stripped.startswith("Pages active:"):
            active_pages = _darwin_pages_value(stripped)
        elif stripped.startswith("Pages wired down:"):
            wired_pages = _darwin_pages_value(stripped)
        elif stripped.startswith("Pages occupied by compressor:"):
            compressed_pages = _darwin_pages_value(stripped)
    used = (active_pages + wired_pages + compressed_pages) * page_size
    return min(max(used, 0), total_bytes)


def _darwin_pages_value(line: str) -> int:
    """Return one integer page count from a `vm_stat` line."""
    try:
        return int(line.split(":", 1)[1].strip().rstrip("."))
    except (IndexError, ValueError):
        return 0


def _sysctl_int(key: str) -> int:
    """Return one integer sysctl value."""
    import subprocess
    try:
        result = subprocess.run(
            ["sysctl", "-n", key],
            capture_output=True,
            check=True,
            text=True,
        )
        return int(result.stdout.strip())
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0


def _meminfo_line_bytes(line: str) -> int:
    """Return one byte value from a `/proc/meminfo` line."""
    try:
        value = int(line.split(":", 1)[1].strip().split()[0])
    except (IndexError, ValueError):
        return 0
    return value * 1024
