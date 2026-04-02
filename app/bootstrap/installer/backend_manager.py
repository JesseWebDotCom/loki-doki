"""Backend runtime and dependency management."""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path
from typing import Any


def current_backend_signature(requirements_path: Path) -> str:
    """Return a unique hash based on the current requirements-app.txt file."""
    if not requirements_path.exists():
        return "missing"
    return hashlib.sha256(requirements_path.read_bytes()).hexdigest()


def ensure_runtime(runtime_dir: Path, runtime_python: Path) -> None:
    """Ensure the managed Python venv exists."""
    if runtime_python.exists():
        return
    runtime_dir.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["python3", "-m", "venv", str(runtime_dir)], check=True)


def install_backend(runtime_python: Path, requirements_path: Path, log_file: Path) -> None:
    """Install core application dependencies via pip."""
    with log_file.open("a", encoding="utf-8") as f:
        subprocess.run(
            [str(runtime_python), "-m", "pip", "install", "--upgrade", "pip"],
            check=True,
            stdout=f,
            stderr=f,
        )
        subprocess.run(
            [str(runtime_python), "-m", "pip", "install", "-r", str(requirements_path)],
            check=True,
            stdout=f,
            stderr=f,
        )
def start_app(runtime_python: Path, root_dir: Path, log_file: Path) -> Any:
    """Launch the main FastAPI server in the background."""
    from app.config import APP_PORT
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root_dir)
    return subprocess.Popen(
        [
            str(runtime_python),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(APP_PORT),
        ],
        cwd=str(root_dir),
        stdout=open(log_file, "a"),
        stderr=open(log_file, "a"),
        env=env,
    )
