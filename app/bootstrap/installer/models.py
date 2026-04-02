"""Installer step and state definitions."""

from __future__ import annotations

from typing import Any, TypedDict, Literal, Optional, Union

class InstallerStep(TypedDict):
    id: str
    label: str
    icon: str
    status: Literal["pending", "running", "done", "failed"]
    pct: int

class InstallerState(TypedDict):
    profile: str
    setup_defaults: dict[str, Any]
    status: Literal["idle", "running", "ready", "failed"]
    current_action: str
    current_step: str
    setup_required: bool
    app_running: bool
    ready: bool
    can_launch: bool
    blocking_issues: list[str]
    error: Optional[str]
    steps: list[InstallerStep]
    log_tail: list[str]
    backend_signature: str
    platform_signature: str
    frontend_signature: str


def default_steps() -> list[InstallerStep]:
    """Return the list of installer pipeline stages."""
    return [
        {"id": "profile", "label": "Profile", "icon": "monitor", "status": "done", "pct": 5},
        {"id": "runtime", "label": "Python", "icon": "binary", "status": "pending", "pct": 10},
        {"id": "backend", "label": "Core", "icon": "server", "status": "pending", "pct": 20},
        {"id": "platform_base", "label": "Engine", "icon": "cpu", "status": "pending", "pct": 30},
        {"id": "platform_speech", "label": "Voice", "icon": "mic", "status": "pending", "pct": 40},
        {"id": "platform_llm", "label": "Intelligence", "icon": "brain", "status": "pending", "pct": 55},
        {"id": "platform_vision", "label": "Vision", "icon": "eye", "status": "pending", "pct": 70},
        {"id": "platform_image", "label": "Images", "icon": "image", "status": "pending", "pct": 85},
        {"id": "frontend", "label": "Assets", "icon": "package", "status": "pending", "pct": 90},
        {"id": "build", "label": "Compilation", "icon": "wrench", "status": "pending", "pct": 95},
        {"id": "setup", "label": "Setup", "icon": "settings", "status": "pending", "pct": 95},
        {"id": "skills", "label": "Skills", "icon": "puzzle", "status": "pending", "pct": 98},
        {"id": "app", "label": "Ready", "icon": "rocket", "status": "pending", "pct": 100},
    ]


def default_state(profile: str, setup_defaults: dict[str, Any], config_exists: bool) -> InstallerState:
    """Return the initial installer state."""
    return {
        "profile": profile,
        "setup_defaults": setup_defaults,
        "status": "idle",
        "current_action": "Ready to begin installation.",
        "current_step": "profile",
        "setup_required": not config_exists,
        "app_running": False,
        "ready": False,
        "can_launch": False,
        "blocking_issues": [],
        "error": None,
        "steps": default_steps(),
        "log_tail": [],
        "backend_signature": "",
        "platform_signature": "",
        "frontend_signature": "",
    }
