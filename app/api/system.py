"""System and diagnostic API routes."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.settings import SettingsRequest, ProfileRequest
from app.runtime import runtime_context, health_payload, bootstrap_payload, hailo_payload, update_runtime_profile
from app.settings import store as settings_store
from app.settings import theme as theme_settings
from app.debug import DEBUG_MODE_KEY, debug_logs_payload, is_admin_user
from app.api.chat_helpers import chat_state_payload
from app.api.utils import sanitize_user

router = APIRouter(prefix="", tags=["system"])


@router.get("/health")
def health() -> dict[str, Any]:
    """Return application health."""
    with connection_scope() as connection:
        return health_payload(connection, APP_CONFIG)


@router.get("/bootstrap")
def bootstrap_details() -> dict[str, Any]:
    """Return app bootstrap details for the UI."""
    with connection_scope() as connection:
        return bootstrap_payload(connection, APP_CONFIG)


@router.get("/providers")
def provider_details() -> dict[str, Any]:
    """Return provider selection for the active profile."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
    return {
        "profile": context["settings"]["profile"],
        "models": context["models"],
        "providers": {key: value.to_dict() for key, value in context["providers"].items()},
    }


@router.get("/hailo/status")
def hailo_status() -> dict[str, Any]:
    """Return Hailo runtime status and probe results."""
    with connection_scope() as connection:
        return hailo_payload(connection, APP_CONFIG)


@router.get("/settings")
def get_settings(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return current user settings and chat state."""
    from app.subsystems.character import character_service # Avoid circularity
    with connection_scope() as connection:
        theme_payload = theme_settings.get_effective_theme_settings(connection, current_user["id"])
        debug_mode = bool(db.get_user_setting(connection, current_user["id"], DEBUG_MODE_KEY, False))
        chat_state = chat_state_payload(connection, current_user["id"])
        voice_preferences = settings_store.load_voice_preferences(connection, current_user["id"])
        wakeword_preferences = settings_store.load_wakeword_preferences(connection, current_user["id"])
        
        # Character settings
        settings_payload = character_service.get_user_settings(connection, current_user["id"])
        settings_payload.pop("admin_prompt", None)
        settings_payload.pop("blocked_topics", None)
        account_payload = character_service.get_account(connection, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        care_profiles = character_service.list_care_profiles(connection)
        characters = character_service.list_characters(connection, APP_CONFIG)
        character_settings = {
            **settings_payload,
            "account_default_character_id": account_payload["default_character_id"],
            "character_feature_enabled": account_payload["character_feature_enabled"],
            "care_profiles": care_profiles,
            "characters": characters["installed"],
        }
        is_admin = is_admin_user(current_user, APP_CONFIG)
    return {
        **theme_payload,
        "debug_mode": debug_mode if is_admin else False,
        "is_admin": is_admin,
        **chat_state,
        "voice_reply_enabled": bool(voice_preferences["reply_enabled"]),
        "voice_source": str(voice_preferences["voice_source"]),
        "browser_voice_uri": str(voice_preferences["browser_voice_uri"]),
        "piper_voice_id": str(voice_preferences["piper_voice_id"]),
        "barge_in_enabled": bool(voice_preferences["barge_in_enabled"]),
        "wakeword_enabled": bool(wakeword_preferences["enabled"]),
        "wakeword_model_id": str(wakeword_preferences["model_id"]),
        "wakeword_threshold": float(wakeword_preferences["threshold"]),
        **character_settings,
    }


@router.get("/debug/logs")
def get_debug_logs(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return local app logs for admins."""
    if not is_admin_user(current_user, APP_CONFIG):
        raise HTTPException(status_code=403, detail="Admin access is required.")
    return debug_logs_payload(APP_CONFIG)


@router.put("/settings")
def update_settings(
    payload: SettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist user-level preferences."""
    with connection_scope() as connection:
        if payload.theme is not None and payload.theme_preset_id is None and payload.theme_mode is None:
            legacy_preset, legacy_mode = theme_settings.migrate_legacy_theme(payload.theme)
            theme_settings.save_user_theme_preferences(
                connection,
                current_user["id"],
                theme_preset_id=legacy_preset,
                theme_mode=legacy_mode,
            )
        if payload.theme_preset_id is not None or payload.theme_mode is not None:
            theme_settings.save_user_theme_preferences(
                connection,
                current_user["id"],
                theme_preset_id=payload.theme_preset_id,
                theme_mode=payload.theme_mode,
            )
        if payload.debug_mode is not None:
             db.set_user_setting(connection, current_user["id"], DEBUG_MODE_KEY, payload.debug_mode)
        
        voice_prefs = settings_store.load_voice_preferences(connection, current_user["id"])
        if payload.voice_reply_enabled is not None:
             voice_prefs["reply_enabled"] = payload.voice_reply_enabled
        if payload.voice_source is not None:
             voice_prefs["voice_source"] = payload.voice_source
        if payload.browser_voice_uri is not None:
             voice_prefs["browser_voice_uri"] = payload.browser_voice_uri
        if payload.piper_voice_id is not None:
             voice_prefs["piper_voice_id"] = payload.piper_voice_id
        if payload.barge_in_enabled is not None:
             voice_prefs["barge_in_enabled"] = payload.barge_in_enabled
        settings_store.save_voice_preferences(connection, current_user["id"], voice_prefs)
    return get_settings(current_user)


@router.post("/profile")
def update_node_profile(
    payload: ProfileRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Swap the active hardware profile (mac, pi_cpu, pi_hailo)."""
    from app.deps import enforce_admin
    enforce_admin(current_user)
    with connection_scope() as connection:
        update_runtime_profile(connection, APP_CONFIG, payload.profile)
    return {"ok": True, "profile": payload.profile}
