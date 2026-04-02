"""Auth-related API routes."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.auth import LoginRequest, RegisterRequest, ProfileSettingsRequest
from app.security import create_access_token, hash_password, verify_password
from app.api.utils import sanitize_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login")
def login(payload: LoginRequest) -> dict[str, Any]:
    """Authenticate a local user and return a JWT."""
    with connection_scope() as connection:
        user = db.get_user_by_username(connection, payload.username.strip())
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = create_access_token(user["id"], user["username"], APP_CONFIG.jwt_secret)
    return {"access_token": token, "user": sanitize_user(user)}


@router.post("/register")
def register(payload: RegisterRequest) -> dict[str, Any]:
    """Create a user if self-signup is enabled."""
    with connection_scope() as connection:
        settings = db.get_app_settings(connection)
        if not settings["allow_signup"]:
            raise HTTPException(status_code=403, detail="Self-signup is disabled.")
        if db.get_user_by_username(connection, payload.username.strip()):
            raise HTTPException(status_code=409, detail="Username already exists.")
        user = db.create_user(
            connection,
            username=payload.username.strip(),
            display_name=payload.display_name.strip(),
            password_hash=hash_password(payload.password),
        )
    token = create_access_token(user["id"], user["username"], APP_CONFIG.jwt_secret)
    return {"access_token": token, "user": sanitize_user(user)}


@router.get("/me")
def me(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return the authenticated user."""
    return {"user": sanitize_user(current_user)}


@router.put("/profile")
def update_profile_settings(
    payload: ProfileSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Update the signed-in user's display name or password."""
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
