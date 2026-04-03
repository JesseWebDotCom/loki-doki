"""Modular API routers for LokiDoki."""

from __future__ import annotations

from . import (
    admin, admin_voices, analysis, auth, character, chat, lab, memory, settings, skills, system, vision, voice
)

# Export for main.py convenience
__all__ = [
    "admin", "admin_voices", "analysis", "auth", "character", "chat", "lab", "memory", "settings", "skills", "system", "vision", "voice"
]
