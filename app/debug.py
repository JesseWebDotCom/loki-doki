"""Admin-only debug helpers for timing and log visibility."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.config import AppConfig, load_bootstrap_config


DEBUG_MODE_KEY = "debug_mode"
LOG_TAIL_LINES = 120


def is_admin_user(user: dict[str, Any], app_config: AppConfig) -> bool:
    """Return whether the current user is an admin."""
    if bool(user.get("is_admin")):
        return True
    config = load_bootstrap_config(app_config.bootstrap_config_path)
    admin_username = str(config.get("admin", {}).get("username", "")).strip()
    return bool(admin_username and user.get("username") == admin_username)


def debug_logs_payload(app_config: AppConfig) -> dict[str, Any]:
    """Return tail logs for local debugging surfaces."""
    data_dir = app_config.data_dir
    return {
        "sections": [
            _log_section("app", "App", data_dir / "app.log"),
            _log_section("installer", "Installer", data_dir / "installer.log"),
            _log_section("ollama", "Ollama", data_dir / "ollama.log"),
            _log_section("hailo_ollama", "Hailo Ollama", data_dir / "hailo-ollama.log"),
        ]
    }


def _log_section(key: str, label: str, path: Path) -> dict[str, Any]:
    """Return one log section payload."""
    return {
        "key": key,
        "label": label,
        "path": str(path),
        "exists": path.exists(),
        "lines": read_log_tail(path),
    }


def read_log_tail(path: Path, line_count: int = LOG_TAIL_LINES) -> list[str]:
    """Return the last N lines from one local log file."""
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="ignore").splitlines()[-line_count:]
