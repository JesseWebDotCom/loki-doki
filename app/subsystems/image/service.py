"""Business logic for Phase 4 image analysis."""

from __future__ import annotations

from dataclasses import dataclass

from app.providers.types import ProviderSpec
from app.subsystems.image.vision import (
    ProviderRequestError,
    VisionRequestError,
    analyze_with_provider,
    extract_image_payload,
    fallback_provider_for,
    provider_failure_message,
    select_vision_provider,
)


DEFAULT_IMAGE_PROMPT = "Describe this image clearly and concisely."


class ImageAnalysisError(RuntimeError):
    """Raised when image analysis cannot be completed."""


@dataclass(frozen=True)
class ImageAnalysisResult:
    """Image analysis reply plus execution metadata."""

    reply: str
    provider: ProviderSpec


def analyze_image(
    image_data_url: str,
    prompt: str,
    profile: str,
    providers: dict[str, ProviderSpec],
) -> ImageAnalysisResult:
    """Return a description for one uploaded image."""
    try:
        image_base64 = extract_image_payload(image_data_url)
        provider = select_vision_provider(profile, providers)
    except VisionRequestError as exc:
        raise ImageAnalysisError(str(exc)) from exc
    final_prompt = prompt.strip() or DEFAULT_IMAGE_PROMPT
    try:
        return ImageAnalysisResult(
            reply=analyze_with_provider(provider, final_prompt, image_base64),
            provider=provider,
        )
    except ProviderRequestError as exc:
        fallback_provider = fallback_provider_for(profile, provider)
        if fallback_provider is not None:
            try:
                return ImageAnalysisResult(
                    reply=analyze_with_provider(fallback_provider, final_prompt, image_base64),
                    provider=fallback_provider,
                )
            except ProviderRequestError as fallback_exc:
                raise ImageAnalysisError(
                    provider_failure_message("Image", fallback_provider, profile, str(fallback_exc))
                ) from fallback_exc
        raise ImageAnalysisError(provider_failure_message("Image", provider, profile, str(exc))) from exc
