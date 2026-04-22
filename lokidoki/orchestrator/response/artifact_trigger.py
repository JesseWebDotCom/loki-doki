"""Artifact-mode trigger rules.

Chunk 20 narrows artifact mode so it only activates on explicit
artifact asks. No regex over raw user text: the decision branches on
structured inputs only.
"""
from __future__ import annotations

import platform
from pathlib import Path
from typing import Optional


_ARTIFACT_INTENTS: frozenset[str] = frozenset({
    "interactive_visualization",
    "artifact_generation",
    "artifact_html",
    "artifact_svg",
    "artifact_js_viz",
})


def _normalize_override(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if stripped in ("direct", "standard", "rich", "deep", "search", "artifact"):
        return stripped
    return None


def _resolve_profile(
    decomposition: object,
    profile: Optional[str],
) -> str:
    if isinstance(profile, str) and profile.strip():
        return profile.strip()
    hinted = getattr(decomposition, "platform_profile", None)
    if isinstance(hinted, str) and hinted.strip():
        return hinted.strip()
    system = platform.system()
    if system == "Darwin":
        return "mac"
    if system == "Windows":
        return "windows"
    if system == "Linux":
        model = Path("/proc/device-tree/model")
        if model.exists():
            try:
                text = model.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                text = ""
            if "Raspberry Pi 5" in text:
                hailo_paths = (
                    Path("/dev/hailo0"),
                    Path("/usr/bin/hailortcli"),
                )
                return "pi_hailo" if any(path.exists() for path in hailo_paths) else "pi_cpu"
        return "linux"
    return "linux"


def should_use_artifact_mode(
    decomposition: object,
    user_override: Optional[str],
    *,
    profile: Optional[str] = None,
) -> bool:
    """Return ``True`` when the planner should allow artifact mode.

    Rules:

    * Explicit ``user_override="artifact"`` always wins.
    * Any other explicit override blocks artifact mode.
    * ``pi_cpu`` never auto-triggers artifact mode; the user must opt in.
    * Otherwise, only a known structured artifact intent may trigger it.
    """
    override = _normalize_override(user_override)
    if override == "artifact":
        return True
    if override is not None:
        return False

    resolved_profile = _resolve_profile(decomposition, profile)
    if resolved_profile == "pi_cpu":
        return False

    intent = str(getattr(decomposition, "intent", "") or "").strip()
    return intent in _ARTIFACT_INTENTS


__all__ = ["should_use_artifact_mode"]
