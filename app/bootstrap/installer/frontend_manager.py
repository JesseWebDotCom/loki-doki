"""Frontend dependencies and build management."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import shutil
from pathlib import Path
from typing import Any


def current_frontend_signature(ui_dir: Path) -> str:
    """Return a unique hash based on the current ui/ package-lock.json and source files."""
    lock_file = ui_dir / "package-lock.json"
    if not lock_file.exists():
        return "missing"
    return hashlib.sha256(lock_file.read_bytes()).hexdigest()


def install_frontend(ui_dir: Path, log_file: Path) -> None:
    """Install frontend dependencies via npm."""
    with log_file.open("a", encoding="utf-8") as f:
        subprocess.run(
            ["npm", "install"],
            cwd=str(ui_dir),
            check=True,
            stdout=f,
            stderr=f,
        )


def build_frontend(ui_dir: Path, log_file: Path) -> None:
    """Build the React application via Vite."""
    with log_file.open("a", encoding="utf-8") as f:
        subprocess.run(
            ["npm", "run", "build"],
            cwd=str(ui_dir),
            check=True,
            stdout=f,
            stderr=f,
        )
