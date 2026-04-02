"""Metrics orchestration service."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from app.metrics import platform, process, storage


def runtime_metrics_payload(data_path: Path, profile: str) -> dict[str, Any]:
    """Return system and process metrics for the local node."""
    disk = shutil.disk_usage(data_path)
    total_memory = platform.total_memory_bytes()
    used_memory = platform.used_memory_bytes(total_memory)
    processes = process.tracked_processes_payload(profile)
    storage_buckets = storage.storage_buckets_payload(data_path, profile)
    
    system = {
        "cpu": {
            "load_percent": platform.cpu_load_percent(),
            "cpu_count": os.cpu_count() or 1,
        },
        "memory": {
            "used_bytes": used_memory,
            "total_bytes": total_memory,
            "used_percent": platform.calculate_percent(used_memory, total_memory),
        },
        "disk": {
            "used_bytes": disk.used,
            "total_bytes": disk.total,
            "used_percent": platform.calculate_percent(disk.used, disk.total),
            "path": str(data_path),
        },
    }
    
    return {
        "system": system,
        "processes": processes,
        "storage": storage_buckets,
        "resources": _resource_groups(system, processes, storage_buckets),
    }


def _resource_groups(
    system: dict[str, Any],
    processes: list[dict[str, Any]],
    storage_buckets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return the three dashboard resource groups."""
    lokidoki_disk_used = storage.storage_total(storage_buckets, {"lokidoki_repo", "lokidoki_data"})
    ollama_disk_used = storage.storage_total(storage_buckets, {"ollama_home", "ollama_models"})
    total_disk = int(system["disk"]["total_bytes"])
    
    lokidoki_process = process.process_by_label(processes, "LokiDoki App")
    ollama_process = process.process_by_label(processes, "Ollama")
    
    total_memory = int(system["memory"]["total_bytes"])
    
    return [
        {
            "key": "system",
            "label": "System",
            "cpu_percent": float(system["cpu"]["load_percent"]),
            "memory_percent": float(system["memory"]["used_percent"]),
            "memory_used_bytes": int(system["memory"]["used_bytes"]),
            "memory_total_bytes": total_memory,
            "disk_percent": float(system["disk"]["used_percent"]),
            "disk_used_bytes": int(system["disk"]["used_bytes"]),
            "disk_total_bytes": total_disk,
            "detail": f'{int(system["cpu"]["cpu_count"])} cores visible on this node',
        },
        {
            "key": "lokidoki",
            "label": "LokiDoki",
            "cpu_percent": float(lokidoki_process["cpu_percent"]),
            "memory_percent": platform.calculate_percent(int(lokidoki_process["memory_bytes"]), total_memory),
            "memory_used_bytes": int(lokidoki_process["memory_bytes"]),
            "memory_total_bytes": total_memory,
            "disk_percent": platform.calculate_percent(lokidoki_disk_used, total_disk),
            "disk_used_bytes": lokidoki_disk_used,
            "disk_total_bytes": total_disk,
            "detail": "Repo plus local app data",
        },
        {
            "key": "ollama",
            "label": "Ollama",
            "cpu_percent": float(ollama_process["cpu_percent"]),
            "memory_percent": platform.calculate_percent(int(ollama_process["memory_bytes"]), total_memory),
            "memory_used_bytes": int(ollama_process["memory_bytes"]),
            "memory_total_bytes": total_memory,
            "disk_percent": platform.calculate_percent(ollama_disk_used, total_disk),
            "disk_used_bytes": ollama_disk_used,
            "disk_total_bytes": total_disk,
            "detail": "Ollama service plus model store",
        },
    ]
