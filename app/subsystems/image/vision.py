"""Shared vision-provider helpers for media subsystems."""

from __future__ import annotations

from typing import Optional
from app.config import get_profile_defaults
from app.providers.types import ProviderSpec
from app.subsystems.image.client import analyze_image_completion
from app.subsystems.image.hailo_client import analyze_hailo_image_completion
from app.subsystems.text.client import ProviderRequestError


MAX_IMAGE_BASE64_LENGTH = 1_500_000


class VisionRequestError(RuntimeError):
    """Raised when a media request cannot be prepared for local vision."""


def extract_image_payload(image_data_url: str) -> str:
    """Return the base64 payload from a browser image data URL."""
    prefix = "data:image/"
    if not image_data_url.startswith(prefix) or ";base64," not in image_data_url:
        raise VisionRequestError("Media uploads must be browser image data URLs with base64 content.")
    payload = image_data_url.split(";base64,", 1)[1].strip()
    if len(payload) > MAX_IMAGE_BASE64_LENGTH:
        raise VisionRequestError("Media upload is too large for local analysis. Try a smaller file.")
    return payload


def select_vision_provider(profile: str, providers: dict[str, ProviderSpec]) -> ProviderSpec:
    """Return the active vision provider or a configured CPU fallback."""
    provider = providers["vision"]
    if provider.backend == "hailort":
        return provider
    if provider.backend == "ollama" and provider.endpoint:
        return provider
    fallback_provider = fallback_provider_for(profile, provider)
    if fallback_provider is not None:
        return fallback_provider
    raise VisionRequestError(
        f"Vision analysis is unavailable on the {profile} profile because {provider.backend} is not ready."
    )


def analyze_with_provider(provider: ProviderSpec, prompt: str, image_base64: str) -> str:
    """Dispatch one image prompt to the active vision backend."""
    if provider.backend == "hailort":
        return analyze_hailo_image_completion(provider, prompt, image_base64)
    return analyze_image_completion(provider, prompt, image_base64)


def fallback_provider_for(profile: str, provider: ProviderSpec) -> Optional[ProviderSpec]:
    """Return the configured CPU fallback provider, if available."""
    if provider.fallback_backend != "ollama":
        return None
    fallback_profile = "pi_cpu" if profile in {"pi_cpu", "pi_hailo"} else "mac"
    fallback_model = provider.fallback_model or get_profile_defaults(fallback_profile)["vision_model"]
    return ProviderSpec(
        name="vision_fallback",
        backend="ollama",
        model=fallback_model,
        acceleration="cpu",
        endpoint="http://127.0.0.1:11434",
        notes="CPU fallback active for media analysis.",
    )


def provider_failure_message(kind: str, provider: ProviderSpec, profile: str, detail: str) -> str:
    """Return a user-facing media-analysis error."""
    return (
        f"{kind} analysis is unavailable on the {profile} profile. "
        f"LokiDoki could not reach {provider.backend} for model {provider.model}. "
        f"{detail}"
    )


__all__ = [
    "MAX_IMAGE_BASE64_LENGTH",
    "VisionRequestError",
    "analyze_with_provider",
    "extract_image_payload",
    "fallback_provider_for",
    "provider_failure_message",
    "select_vision_provider",
    "ProviderRequestError",
]
