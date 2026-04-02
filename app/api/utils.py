"""Shared API utilities and internal mapping helpers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional, Union
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app import db
from app.debug import is_admin_user
from app.deps import APP_CONFIG
from app.subsystems.character import character_service
from app.subsystems.live_video.face_recognition import registration_is_complete

UI_SHELL_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
}


class CachedAssetStaticFiles(StaticFiles):
    """Custom StaticFiles server that injects immutable cache headers for hashed assets."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def is_hashed_asset(self, path: str) -> bool:
        """Return whether a path looks like a Vite/hashed production asset."""
        return "/assets/" in path and any(char.isdigit() for char in path)

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        path = args[0] if args else kwargs.get("path", "")
        if self.is_hashed_asset(str(path)):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def execution_meta(provider: Any) -> dict[str, Any]:
    """Return execution metadata for one resolved provider."""
    return {
        "provider": provider.name,
        "backend": provider.backend,
        "model": provider.model,
        "acceleration": provider.acceleration,
    }


def sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    """Return a public-safe user payload."""
    return {
        "id": user["id"],
        "account_id": user.get("account_id", ""),
        "username": user["username"],
        "display_name": user["display_name"],
        "bio": user["bio"],
        "relationships": json.loads(user["relationships_json"] or "{}"),
        "is_admin": is_admin_user(user, APP_CONFIG),
    }


def registered_person_payload(record: Any) -> dict[str, Any]:
    """Return one registered-person payload for the UI."""
    return {
        "name": record.name,
        "sample_count": int(getattr(record, "sample_count", 0) or 0),
        "modes": list(getattr(record, "modes", ()) or ()),
        "is_complete": registration_is_complete(record),
    }


def admin_user_summary(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    """Return one admin-management payload for the UI."""
    enriched = {**user, "is_admin": db.get_user_admin_flag(conn, user["id"])}
    character_settings = character_service.get_user_settings(conn, enriched["id"])
    return {
        "id": enriched["id"],
        "username": enriched["username"],
        "display_name": enriched["display_name"],
        "created_at": enriched.get("created_at", ""),
        "is_admin": is_admin_user(enriched, APP_CONFIG),
        "care_profile_id": character_settings["care_profile_id"],
        "character_enabled": character_settings["character_enabled"],
        "assigned_character_id": character_settings["assigned_character_id"],
        "can_select_character": character_settings["can_select_character"],
        "admin_prompt": character_settings["admin_prompt"],
        "blocked_topics": character_settings["blocked_topics"],
        "compiled_base_prompt": character_settings["compiled_base_prompt"],
        "compiled_prompt_hash": character_settings["compiled_prompt_hash"],
    }
