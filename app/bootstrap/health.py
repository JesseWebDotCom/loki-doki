"""Health checks for the bootstrap flow."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from app.config import get_profile_defaults, load_bootstrap_config
from app.providers import capability_summary, resolve_providers


def evaluate_health(manager: Any) -> dict[str, Any]:
    """Return installer-facing health cards."""
    app_python = manager.runtime_python

    def _image_models_status() -> tuple[str, str]:
        if not manager.bootstrap_config_path.exists():
            return "warn", "Not configured."
        cache_path = Path.home() / ".cache" / "huggingface" / "hub"
        try:
            if manager._image_models_cached():
                return "ok", f"Models are cached in {cache_path}."
            return "warn", f"Models missing from {cache_path}."
        except Exception as exc:
            return "error", f"Cache check failed: {exc}"

    config = load_bootstrap_config(manager.bootstrap_config_path)
    profile = config.get("profile", manager.profile)
    models = config.get("models", get_profile_defaults(profile))
    providers = resolve_providers(profile, models)
    cards = [
        {
            "key": "profile",
            "label": "Detected profile",
            "status": "ok",
            "detail": profile,
        },
        {
            "key": "python",
            "label": "Managed Python runtime",
            "status": "ok" if app_python.exists() else "warn",
            "detail": (
                str(app_python)
                if app_python.exists()
                else "Runtime has not been created yet."
            ),
        },
        {
            "key": "npm",
            "label": "Node/npm",
            "status": (
                "ok"
                if shutil.which("npm")
                else ("warn" if manager.ui_dist_dir.exists() else "error")
            ),
            "detail": (
                "npm available"
                if shutil.which("npm")
                else (
                    "npm is unavailable, but a synced React dist bundle is present."
                    if manager.ui_dist_dir.exists()
                    else "npm is required for the React UI build."
                )
            ),
        },
        {
            "key": "frontend",
            "label": "Built React UI",
            "status": "ok" if manager.ui_dist_dir.exists() else "warn",
            "detail": (
                "dist ready"
                if manager.ui_dist_dir.exists()
                else "Run installer build steps to generate app/ui/dist."
            ),
        },
        {
            "key": "config",
            "label": "Bootstrap config",
            "status": "ok" if manager.bootstrap_config_path.exists() else "warn",
            "detail": (
                "Initial setup saved."
                if manager.bootstrap_config_path.exists()
                else "First-run setup has not been completed."
            ),
        },
        {
            "key": "providers",
            "label": "Provider routing",
            "status": "ok",
            "detail": (
                f"Fast LLM: {providers['llm_fast'].backend}, "
                f"Thinking LLM: {providers['llm_thinking'].backend}, "
                f"Vision: {providers['vision'].backend}, "
                f"Image Gen: {providers['image_gen'].backend if 'image_gen' in providers else 'local'}"
            ),
        },
        {
            "key": "image_gen",
            "label": "Image Generation",
            "status": _image_models_status()[0],
            "detail": (
                f"diffusers / {models.get('image_gen_model', 'none')} / {_image_models_status()[1]}"
            ),
        },
        {
            "key": "app",
            "label": "Main app",
            "status": "ok" if manager.is_app_reachable() else "warn",
            "detail": (
                manager.internal_app_url
                if manager.is_app_reachable()
                else "FastAPI app is not running yet."
            ),
        },
    ]
    cards.extend(card.to_dict() for card in capability_summary(profile, models))
    status = manager.get_status()
    return {
        "cards": cards,
        "blocking_issues": status.get("blocking_issues", []),
        "can_launch": bool(status.get("can_launch")),
    }
