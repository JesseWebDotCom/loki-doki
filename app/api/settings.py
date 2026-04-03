"""Compatibility settings routes for the React app shell."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.api.utils import sanitize_user
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.auth import ProfileSettingsRequest
from app.models.character import CharacterSettingsRequest
from app.security import hash_password, verify_password
from app.subsystems.character import character_service

router = APIRouter(prefix="/settings", tags=["settings"])


@router.put("/profile")
def update_profile_settings_alias(
    payload: ProfileSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Compatibility alias for updating the signed-in user's profile."""
    with connection_scope() as connection:
        user = db.get_user_by_id(connection, current_user["id"])
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if payload.display_name is not None:
            next_display_name = payload.display_name.strip()
            if not next_display_name:
                raise HTTPException(status_code=400, detail="Display name is required.")
            db.update_user_profile(connection, current_user["id"], next_display_name)
        if payload.new_password is not None:
            if not payload.current_password or not verify_password(payload.current_password, user["password_hash"]):
                raise HTTPException(status_code=400, detail="Current password is incorrect.")
            if len(payload.new_password) < 8:
                raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
            db.update_user_password(connection, current_user["id"], hash_password(payload.new_password))
        refreshed = db.get_user_by_id(connection, current_user["id"])
    assert refreshed is not None
    return {"ok": True, "user": sanitize_user(refreshed)}


@router.put("/character")
def update_character_settings_alias(
    payload: CharacterSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Compatibility alias for updating user-level character settings."""
    with connection_scope() as connection:
        updated = character_service.update_user_settings(
            connection,
            current_user["id"],
            payload.dict(exclude_none=True),
        )
        account = character_service.get_account(connection, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        care_profiles = character_service.list_care_profiles(connection)
        characters = character_service.list_characters(connection, APP_CONFIG)
    return {
        **updated,
        "account_default_character_id": account["default_character_id"],
        "character_feature_enabled": account["character_feature_enabled"],
        "care_profiles": care_profiles,
        "characters": characters["installed"],
    }
