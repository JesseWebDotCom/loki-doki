"""Platform service (LLM, Vision, TTS) installation and verification."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from app.providers.ollama import probe_provider_model
from app.providers.registry import resolve_providers
from app.providers.types import ProviderSpec

LOGGER = logging.getLogger(__name__)


def current_platform_signature(profile: str, models: dict[str, str]) -> str:
    """Return a combined hash for the current profile and model selection."""
    return hashlib.sha256(
        f"{profile}:{json.dumps(models, sort_keys=True)}".encode("utf-8")
    ).hexdigest()


def probe_runtime_endpoint(spec: ProviderSpec) -> dict[str, str | bool]:
    """Probe one live provider endpoint."""
    from app.providers.ollama import probe_provider_endpoint
    probe = probe_provider_endpoint(spec)
    if probe["ok"]:
        return probe
    return {
        "ok": False,
        "detail": f"{spec.backend} is unavailable at {spec.endpoint} ({probe['detail']}).",
    }


def critical_runtime_issues(profile: str, models: dict[str, str]) -> list[str]:
    """Return issues that should block a 'ready' state."""
    providers = resolve_providers(profile, models)
    issues: list[str] = []
    endpoint_results: dict[str, dict[str, str | bool]] = {}

    for key in ("llm_fast", "llm_thinking", "function_model"):
        spec = providers.get(key)
        if not spec or not spec.endpoint or spec.backend not in {"ollama", "hailo_ollama"}:
            continue
        endpoint_results.setdefault(spec.endpoint, probe_runtime_endpoint(spec))
        endpoint_probe = endpoint_results[spec.endpoint]
        if not endpoint_probe["ok"]:
            issues.append(str(endpoint_probe["detail"]))
            continue
        model_probe = probe_provider_model(spec)
        if not model_probe["ok"]:
            issues.append(str(model_probe["detail"]))
    return issues


def ensure_platform_llm(spec: ProviderSpec, validate: bool = True) -> None:
    """Pull LLM weights if missing."""
    # Simplified for extraction, will need to be fleshed out or delegating to providers.ollama
    pass
