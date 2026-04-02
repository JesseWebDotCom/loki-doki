"""Admin-related API routes."""

from __future__ import annotations

from typing import Any
import sqlite3
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user, enforce_admin
from app.models.admin import (
    AdminUserRoleRequest,
    AdminUserPasswordRequest,
    AccountSettingsRequest,
    PromptPolicyRequest,
    UserPromptOverrideRequest,
)
from app.models.character import CharacterSettingsRequest
from app.security import hash_password
from app.subsystems.character import character_service
from app.runtime import runtime_context
from app.metrics import runtime_metrics_payload
from app.api.utils import admin_user_summary

router = APIRouter(prefix="/admin", tags=["admin"])


def _admin_users_payload(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return all users enriched for the admin UI."""
    return [admin_user_summary(conn, user) for user in db.list_users(conn)]


def _admin_count(conn: sqlite3.Connection) -> int:
    """Return the number of users with admin access."""
    return sum(1 for user in db.list_users(conn) if db.get_user_admin_flag(conn, user["id"]))


def _compile_prompts_for_account(
    conn: sqlite3.Connection,
    context: dict[str, Any],
    account_id: str,
) -> None:
    """Compile and persist compact prompts for all users in one account."""
    for user in db.list_users(conn):
        if str(user.get("account_id") or "") != account_id:
            continue
        character_service.build_rendering_context(
            conn,
            user,
            context["settings"]["profile"],
            compiler_provider=context["providers"]["llm_fast"],
        )


@router.get("/users")
def list_admin_users(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return all users for the administration UI."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        return {"users": _admin_users_payload(connection)}


@router.post("/users/{user_id}/role")
def update_admin_user_role(
    user_id: str,
    payload: AdminUserRoleRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Grant or revoke admin access for one user."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        is_target_admin = db.get_user_admin_flag(connection, user["id"])
        if is_target_admin and not payload.is_admin and _admin_count(connection) <= 1:
            raise HTTPException(status_code=400, detail="At least one admin must remain.")
        db.set_user_admin_flag(connection, user_id, payload.is_admin)
        return {"ok": True, "users": _admin_users_payload(connection)}


@router.post("/users/{user_id}/password")
def update_admin_user_password(
    user_id: str,
    payload: AdminUserPasswordRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Set a new password for one user."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        db.update_user_password(connection, user_id, hash_password(payload.password))
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_admin_user(
    user_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one local user."""
    enforce_admin(current_user)
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your current account.")
    with connection_scope() as connection:
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        if db.get_user_admin_flag(connection, user["id"]) and _admin_count(connection) <= 1:
            raise HTTPException(status_code=400, detail="At least one admin must remain.")
        db.delete_user(connection, user_id)
        return {"ok": True, "users": _admin_users_payload(connection)}


@router.get("/account")
def get_admin_account(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return the current household account settings."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        account = character_service.get_account(connection, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        app_settings = db.get_app_settings(connection)
        return {**account, "auto_update_skills": app_settings.get("auto_update_skills", False)}


@router.get("/runtime-metrics")
def get_admin_runtime_metrics(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return runtime metrics for the admin dashboard."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        settings = runtime_context(connection, APP_CONFIG)["settings"]
        user_count = len(db.list_users(connection))
    return {
        "app_name": settings["app_name"],
        "profile": settings["profile"],
        "overview": {
            "nodes_total": 1,
            "nodes_connected": 1,
            "users_total": user_count,
        },
        **runtime_metrics_payload(APP_CONFIG.data_dir, settings["profile"]),
    }


@router.put("/account")
def update_admin_account(
    payload: AccountSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist household account settings."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            account_id = str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID)
            account = character_service.update_account(
                connection,
                account_id,
                payload.dict(exclude_none=True),
            )
            
            # Persist global app settings if provided
            current_settings = db.get_app_settings(connection)
            db.save_app_settings(
                connection,
                profile=current_settings["profile"],
                app_name=payload.name if payload.name is not None else current_settings["app_name"],
                allow_signup=current_settings["allow_signup"],
                auto_update_skills=payload.auto_update_skills if payload.auto_update_skills is not None else current_settings["auto_update_skills"],
            )
            
            _compile_prompts_for_account(connection, context, account_id)
            return {**account, "auto_update_skills": db.get_app_settings(connection)["auto_update_skills"]}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/prompt-policy")
def get_admin_prompt_policy(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return account-level prompt policy."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        return character_service.get_prompt_policy(connection, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))


@router.put("/prompt-policy")
def update_admin_prompt_policy(
    payload: PromptPolicyRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist account-level prompt policy."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        policy = character_service.update_prompt_policy(
            connection,
            str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID),
            payload.dict(exclude_none=True),
        )
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return policy


@router.get("/care-profiles")
def get_admin_care_profiles(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return all care profiles."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        return {"profiles": character_service.list_care_profiles(connection)}


@router.post("/care-profiles")
@router.put("/care-profiles")
def upsert_admin_care_profile(
    payload: Any, # CareProfileRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create or update one care profile."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            profile = character_service.upsert_care_profile(connection, payload.dict())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        
        # Recompile for users assigned to this care profile
        for user in db.list_users(connection):
            settings = character_service.get_user_settings(connection, user["id"])
            if settings["care_profile_id"] == profile["id"]:
                character_service.build_rendering_context(
                    connection,
                    user,
                    context["settings"]["profile"],
                    compiler_provider=context["providers"]["llm_fast"],
                )
        return {"ok": True, "profile": profile, "profiles": character_service.list_care_profiles(connection)}


@router.put("/users/{user_id}/character")
def update_admin_user_character(
    user_id: str,
    payload: CharacterSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist admin-managed character settings for one user."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        character_service.update_user_settings(connection, user_id, payload.dict(exclude_none=True))
        compiled_user = db.get_user_by_id(connection, user_id)
        if compiled_user is not None:
             character_service.build_rendering_context(
                connection,
                compiled_user,
                context["settings"]["profile"],
                compiler_provider=context["providers"]["llm_fast"],
            )
        refreshed = character_service.get_user_settings(connection, user_id)
    return {"ok": True, "settings": refreshed}


@router.put("/users/{user_id}/prompt-overrides")
def update_admin_user_prompt_overrides(
    user_id: str,
    payload: UserPromptOverrideRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist admin-managed prompt overrides for one user."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        character_service.update_user_overrides(connection, user_id, payload.dict())
        compiled_user = db.get_user_by_id(connection, user_id)
        if compiled_user is not None:
            character_service.build_rendering_context(
                connection,
                compiled_user,
                context["settings"]["profile"],
                compiler_provider=context["providers"]["llm_fast"],
            )
        refreshed = character_service.get_user_settings(connection, user_id)
    return {"ok": True, "settings": refreshed}


@router.post("/users/{user_id}/compile-prompt")
def compile_admin_user_prompt(
    user_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Force a compact prompt recompile for one user."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        user = db.get_user_by_id(connection, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        character_service.build_rendering_context(
            connection,
            user,
            context["settings"]["profile"],
            compiler_provider=context["providers"]["llm_fast"],
            force_recompile=True,
        )
        return {"ok": True, "user": admin_user_summary(connection, user)}
