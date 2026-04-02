"""Runtime profile and provider helpers."""

from __future__ import annotations

from typing import Any

from app import db
from app.config import AppConfig, get_profile_defaults, load_bootstrap_config, save_bootstrap_config
from app.providers import capability_summary, resolve_providers
from app.providers.hailo import detect_hardware, probe_hailo_llm, probe_hailo_vision


def runtime_context(connection: Any, app_config: AppConfig) -> dict[str, Any]:
    """Return current settings, models, and providers."""
    settings = db.get_app_settings(connection)
    config = load_bootstrap_config(app_config.bootstrap_config_path)
    models = config.get("models", get_profile_defaults(settings["profile"]))
    providers = resolve_providers(settings["profile"], models)
    return {
        "settings": settings,
        "config": config,
        "models": models,
        "providers": providers,
    }


def health_payload(connection: Any, app_config: AppConfig) -> dict[str, Any]:
    """Build the app health payload."""
    context = runtime_context(connection, app_config)
    settings = context["settings"]
    capabilities = [card.to_dict() for card in capability_summary(settings["profile"], context["models"])]
    return {
        "ok": not any(card["status"] == "error" for card in capabilities),
        "profile": settings["profile"],
        "app_name": settings["app_name"],
        "providers": {key: value.to_dict() for key, value in context["providers"].items()},
        "capabilities": capabilities,
    }


def bootstrap_payload(connection: Any, app_config: AppConfig) -> dict[str, Any]:
    """Build the bootstrap/client payload."""
    context = runtime_context(connection, app_config)
    return {
        **context["settings"],
        "models": context["models"],
        "providers": {key: value.to_dict() for key, value in context["providers"].items()},
    }


def hailo_payload(connection: Any, app_config: AppConfig) -> dict[str, Any]:
    """Build the Hailo probe payload."""
    context = runtime_context(connection, app_config)
    profile = context["settings"]["profile"]
    return {
        "profile": profile,
        "hardware": detect_hardware(),
        "llm_probe": probe_hailo_llm() if profile == "pi_hailo" else {"ok": False, "detail": "Profile does not require Hailo LLM."},
        "vision_probe": (
            probe_hailo_vision(context["models"]["vision_model"])
            if profile == "pi_hailo"
            else {"ok": False, "detail": "Profile does not require Hailo vision."}
        ),
    }


def update_runtime_profile(connection: Any, app_config: AppConfig, next_profile: str) -> dict[str, Any]:
    """Persist a new active runtime profile and return updated context."""
    settings = db.get_app_settings(connection)
    config = load_bootstrap_config(app_config.bootstrap_config_path)
    next_models = get_profile_defaults(next_profile)
    config.update(
        {
            "app_name": settings["app_name"],
            "profile": next_profile,
            "allow_signup": settings["allow_signup"],
            "admin": config.get("admin", {}),
            "models": next_models,
        }
    )
    save_bootstrap_config(config, app_config.bootstrap_config_path)
    db.save_app_settings(
        connection,
        profile=next_profile,
        app_name=settings["app_name"],
        allow_signup=settings["allow_signup"],
    )
    return runtime_context(connection, app_config)
