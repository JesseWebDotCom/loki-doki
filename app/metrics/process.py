"""Process metrics helpers."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


def tracked_processes_payload(profile: str) -> list[dict[str, Any]]:
    """Return tracked LokiDoki runtime processes with lightweight stats."""
    current_pid = os.getpid()
    process_rows = ps_rows()
    tracked = [
        match_process(process_rows, lambda row: row["pid"] == current_pid, "LokiDoki App", "app"),
        match_process(process_rows, is_ollama_process, "Ollama", "llm"),
    ]
    if profile == "pi_hailo":
        tracked.append(match_process(process_rows, is_hailo_ollama_process, "Hailo Ollama", "llm"))
    return tracked


def match_process(
    rows: list[dict[str, Any]],
    predicate,
    label: str,
    kind: str,
) -> dict[str, Any]:
    """Return one tracked process payload."""
    for row in rows:
        if predicate(row):
            return {
                "label": label,
                "kind": kind,
                "running": True,
                "pid": row["pid"],
                "cpu_percent": row["cpu_percent"],
                "memory_bytes": row["memory_bytes"],
                "command": row["command"],
            }
    return {
        "label": label,
        "kind": kind,
        "running": False,
        "pid": None,
        "cpu_percent": 0.0,
        "memory_bytes": 0,
        "command": "",
    }


def ps_rows() -> list[dict[str, Any]]:
    """Return parsed `ps` rows, or an empty list when unavailable."""
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,comm=,%cpu=,rss=,args="],
            capture_output=True,
            check=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    rows: list[dict[str, Any]] = []
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid_text, comm, cpu_text, rss_text, command = parts
        try:
            pid = int(pid_text)
            cpu_percent = float(cpu_text)
            memory_bytes = int(rss_text) * 1024
        except ValueError:
            continue
        rows.append(
            {
                "pid": pid,
                "comm": comm,
                "cpu_percent": round(cpu_percent, 1),
                "memory_bytes": memory_bytes,
                "command": command.strip(),
            }
        )
    return rows


def is_ollama_process(row: dict[str, Any]) -> bool:
    """Return whether one process row is the local Ollama service."""
    command = str(row.get("command", "")).lower()
    comm = str(row.get("comm", "")).lower()
    return "ollama" in {Path(comm).name, comm} or "ollama serve" in command or command.startswith("ollama ")


def is_hailo_ollama_process(row: dict[str, Any]) -> bool:
    """Return whether one process row is the Hailo Ollama service."""
    command = str(row.get("command", "")).lower()
    comm = str(row.get("comm", "")).lower()
    return "hailo-ollama" in command or Path(comm).name == "hailo-ollama"


def process_by_label(processes: list[dict[str, Any]], label: str) -> dict[str, Any]:
    """Return one tracked process by label."""
    for process in processes:
        if process.get("label") == label:
            return process
    return {
        "cpu_percent": 0.0,
        "memory_bytes": 0,
    }
