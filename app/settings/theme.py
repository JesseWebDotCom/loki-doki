"""Theme preference helpers and shared theme metadata."""

from __future__ import annotations

from typing import Any
import sqlite3

from app import db

THEME_PRESET_KEY = "theme_preset_id"
THEME_MODE_KEY = "theme_mode"
THEME_OVERRIDE_ENABLED_KEY = "theme_admin_override_enabled"
THEME_OVERRIDE_PRESET_KEY = "theme_admin_override_preset_id"
THEME_OVERRIDE_MODE_KEY = "theme_admin_override_mode"
LEGACY_THEME_KEY = "theme"

DEFAULT_THEME_PRESET_ID = "familiar"
DEFAULT_THEME_MODE = "dark"
VALID_THEME_MODES = {"light", "dark", "auto"}
VALID_THEME_PRESETS = {"familiar", "studio", "minimal", "amoled"}

AVAILABLE_THEMES: list[dict[str, Any]] = [
    {
        "id": "familiar",
        "name": "Familiar",
        "description": "Neutral, calm, and familiar for everyday chat.",
        "supports_light": True,
        "supports_dark": True,
        "font_label": "Geist",
        "motion_label": "Balanced",
        "radius_label": "Soft",
        "preview": {
            "light": {
                "background": "#f5f7fb",
                "panel": "#ffffff",
                "accent": "#10a37f",
                "text": "#111827",
            },
            "dark": {
                "background": "#0d1117",
                "panel": "#161b22",
                "accent": "#10a37f",
                "text": "#f3f4f6",
            },
        },
    },
    {
        "id": "studio",
        "name": "Studio",
        "description": "The exact character-editor visual language carried app-wide.",
        "supports_light": True,
        "supports_dark": True,
        "font_label": "Geist Variable",
        "motion_label": "Studio",
        "radius_label": "Instrument",
        "preview": {
            "light": {
                "background": "#edf4ff",
                "panel": "#ffffff",
                "accent": "#0ea5e9",
                "text": "#0f172a",
            },
            "dark": {
                "background": "#07111f",
                "panel": "#0f172a",
                "accent": "#38bdf8",
                "text": "#e6f1ff",
            },
        },
    },
    {
        "id": "minimal",
        "name": "Minimal",
        "description": "Cool, restrained, and low-noise for focused work.",
        "supports_light": True,
        "supports_dark": True,
        "font_label": "Geist",
        "motion_label": "Subtle",
        "radius_label": "Crisp",
        "preview": {
            "light": {
                "background": "#f2f4f7",
                "panel": "#fbfcfd",
                "accent": "#2f6fed",
                "text": "#101828",
            },
            "dark": {
                "background": "#0b1020",
                "panel": "#121826",
                "accent": "#7c9bff",
                "text": "#edf2ff",
            },
        },
    },
    {
        "id": "amoled",
        "name": "AMOLED",
        "description": "Pure black surfaces with crisp contrast for OLED screens.",
        "supports_light": True,
        "supports_dark": True,
        "font_label": "Geist",
        "motion_label": "Quiet",
        "radius_label": "Clean",
        "preview": {
            "light": {
                "background": "#f6f7fb",
                "panel": "#ffffff",
                "accent": "#ffffff",
                "text": "#111111",
            },
            "dark": {
                "background": "#000000",
                "panel": "#050505",
                "accent": "#f5f5f5",
                "text": "#ffffff",
            },
        },
    },
]


def sanitize_theme_preset_id(value: Any) -> str:
    """Return one validated theme preset id."""
    if isinstance(value, str) and value in VALID_THEME_PRESETS:
        return value
    return DEFAULT_THEME_PRESET_ID


def sanitize_theme_mode(value: Any) -> str:
    """Return one validated theme mode."""
    if isinstance(value, str) and value in VALID_THEME_MODES:
        return value
    return DEFAULT_THEME_MODE


def migrate_legacy_theme(value: Any) -> tuple[str, str]:
    """Map legacy single-theme values to preset and mode."""
    if value == "dark":
        return DEFAULT_THEME_PRESET_ID, "dark"
    if value == "light":
        return DEFAULT_THEME_PRESET_ID, "light"
    if value == "warm":
        return "studio", "dark"
    return DEFAULT_THEME_PRESET_ID, DEFAULT_THEME_MODE


def get_user_theme_preferences(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return user-saved theme preferences with legacy fallback."""
    stored_preset = db.get_user_setting(conn, user_id, THEME_PRESET_KEY, None)
    stored_mode = db.get_user_setting(conn, user_id, THEME_MODE_KEY, None)
    if stored_preset is None or stored_mode is None:
        legacy_theme = db.get_user_setting(conn, user_id, LEGACY_THEME_KEY, "system")
        legacy_preset, legacy_mode = migrate_legacy_theme(legacy_theme)
        return {
            "theme_preset_id": sanitize_theme_preset_id(stored_preset or legacy_preset),
            "theme_mode": sanitize_theme_mode(stored_mode or legacy_mode),
        }
    return {
        "theme_preset_id": sanitize_theme_preset_id(stored_preset),
        "theme_mode": sanitize_theme_mode(stored_mode),
    }


def get_admin_theme_override(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return admin override theme settings for one user."""
    return {
        "theme_admin_override_enabled": bool(
            db.get_user_setting(conn, user_id, THEME_OVERRIDE_ENABLED_KEY, False)
        ),
        "theme_admin_override_preset_id": sanitize_theme_preset_id(
            db.get_user_setting(conn, user_id, THEME_OVERRIDE_PRESET_KEY, DEFAULT_THEME_PRESET_ID)
        ),
        "theme_admin_override_mode": sanitize_theme_mode(
            db.get_user_setting(conn, user_id, THEME_OVERRIDE_MODE_KEY, DEFAULT_THEME_MODE)
        ),
    }


def get_effective_theme_settings(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Return saved, override, and effective theme settings for one user."""
    preferences = get_user_theme_preferences(conn, user_id)
    override = get_admin_theme_override(conn, user_id)
    if override["theme_admin_override_enabled"]:
        effective_preset = override["theme_admin_override_preset_id"]
        effective_mode = override["theme_admin_override_mode"]
    else:
        effective_preset = preferences["theme_preset_id"]
        effective_mode = preferences["theme_mode"]
    return {
        **preferences,
        **override,
        "effective_theme_preset_id": effective_preset,
        "effective_theme_mode": effective_mode,
        "theme_locked": bool(override["theme_admin_override_enabled"]),
        "available_themes": AVAILABLE_THEMES,
    }


def save_user_theme_preferences(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    theme_preset_id: str | None = None,
    theme_mode: str | None = None,
) -> None:
    """Persist user-selected theme preferences."""
    if theme_preset_id is not None:
        db.set_user_setting(conn, user_id, THEME_PRESET_KEY, sanitize_theme_preset_id(theme_preset_id))
    if theme_mode is not None:
        db.set_user_setting(conn, user_id, THEME_MODE_KEY, sanitize_theme_mode(theme_mode))


def save_admin_theme_override(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    enabled: bool | None = None,
    theme_preset_id: str | None = None,
    theme_mode: str | None = None,
) -> None:
    """Persist admin override theme settings."""
    if enabled is not None:
        db.set_user_setting(conn, user_id, THEME_OVERRIDE_ENABLED_KEY, bool(enabled))
    if theme_preset_id is not None:
        db.set_user_setting(conn, user_id, THEME_OVERRIDE_PRESET_KEY, sanitize_theme_preset_id(theme_preset_id))
    if theme_mode is not None:
        db.set_user_setting(conn, user_id, THEME_OVERRIDE_MODE_KEY, sanitize_theme_mode(theme_mode))
