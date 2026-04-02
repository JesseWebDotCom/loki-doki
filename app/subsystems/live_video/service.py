"""Business logic for Phase 6 object detection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.config import get_profile_defaults
from app.providers.types import ProviderSpec
from app.subsystems.live_video.hailo_object_detector import detect_hailo_objects
from app.subsystems.live_video.cpu_detector import detect_cpu_objects
from app.subsystems.image.vision import VisionRequestError, extract_image_payload
from app.subsystems.live_video.motion_gate import detect_with_motion_gate
from app.subsystems.text.client import ProviderRequestError


class ObjectDetectionError(RuntimeError):
    """Raised when object detection cannot be completed."""


@dataclass(frozen=True)
class BoundingBox:
    """One normalized bounding box."""

    x: float
    y: float
    width: float
    height: float

    def to_dict(self) -> dict[str, float]:
        """Return a JSON-safe payload."""
        return {
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "width": round(self.width, 4),
            "height": round(self.height, 4),
        }


@dataclass(frozen=True)
class DetectedObject:
    """One normalized detection."""

    label: str
    confidence: float
    bbox: BoundingBox

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-safe payload."""
        return {
            "label": self.label,
            "confidence": round(self.confidence, 4),
            "bbox": self.bbox.to_dict(),
        }


@dataclass(frozen=True)
class ObjectDetectionResult:
    """Object detections plus execution metadata."""

    detections: tuple[DetectedObject, ...]
    provider: ProviderSpec


def detect_objects(
    image_data_url: str,
    profile: str,
    providers: dict[str, ProviderSpec],
    confidence_threshold: float = 0.2,
) -> ObjectDetectionResult:
    """Return normalized detections for one uploaded frame."""
    try:
        image_base64 = extract_image_payload(image_data_url)
        provider = select_object_detector_provider(profile, providers)
    except VisionRequestError as exc:
        raise ObjectDetectionError(str(exc)) from exc
    try:
        detections = _normalize_detections(
            _detect_with_motion_gate(profile, image_base64, provider),
            confidence_threshold,
        )
        return ObjectDetectionResult(detections=tuple(detections), provider=provider)
    except ProviderRequestError as exc:
        fallback_provider = fallback_provider_for(profile, provider)
        if fallback_provider is not None:
            try:
                detections = _normalize_detections(
                    _detect_with_motion_gate(profile, image_base64, fallback_provider),
                    confidence_threshold,
                )
                return ObjectDetectionResult(detections=tuple(detections), provider=fallback_provider)
            except ProviderRequestError as fallback_exc:
                raise ObjectDetectionError(
                    provider_failure_message(fallback_provider, profile, str(fallback_exc))
                ) from fallback_exc
        raise ObjectDetectionError(provider_failure_message(provider, profile, str(exc))) from exc


def select_object_detector_provider(profile: str, providers: dict[str, ProviderSpec]) -> ProviderSpec:
    """Return the active object-detection provider or a configured fallback."""
    provider = providers["object_detector"]
    if provider.backend in {"cpu_detector", "hailort"}:
        return provider
    fallback_provider = fallback_provider_for(profile, provider)
    if fallback_provider is not None:
        return fallback_provider
    raise VisionRequestError(
        f"Object detection is unavailable on the {profile} profile because {provider.backend} is not ready."
    )


def fallback_provider_for(profile: str, provider: ProviderSpec) -> Optional[ProviderSpec]:
    """Return the configured CPU fallback provider, if available."""
    if provider.fallback_backend != "cpu_detector":
        return None
    fallback_profile = "pi_cpu" if profile in {"pi_cpu", "pi_hailo"} else "mac"
    fallback_model = provider.fallback_model or get_profile_defaults(fallback_profile)["object_detector_model"]
    return ProviderSpec(
        name="object_detector_fallback",
        backend="cpu_detector",
        model=fallback_model,
        acceleration="cpu",
        notes="CPU fallback active for object detection.",
    )


def provider_failure_message(provider: ProviderSpec, profile: str, detail: str) -> str:
    """Return a user-facing object-detection error."""
    return (
        f"Object detection is unavailable on the {profile} profile. "
        f"LokiDoki could not use {provider.backend} for model {provider.model}. "
        f"{detail}"
    )


def _detect_with_motion_gate(
    profile: str,
    image_base64: str,
    provider: ProviderSpec,
) -> tuple[dict[str, Any], ...]:
    """Run one detector request behind the shared motion gate."""
    return detect_with_motion_gate(
        f"{profile}:object_detector",
        image_base64,
        lambda: _detect_with_provider(provider, image_base64),
    )


def _detect_with_provider(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Dispatch one frame to the active object-detection backend."""
    if provider.backend == "hailort":
        return request_hailo_detections(provider, image_base64)
    if provider.backend == "cpu_detector":
        return request_cpu_detections(provider, image_base64)
    raise ProviderRequestError(f"Unsupported object-detection backend '{provider.backend}'.")


def request_cpu_detections(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Return CPU detection results for one frame."""
    return detect_cpu_objects(provider, image_base64)


def request_hailo_detections(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Return Hailo detection results for one frame."""
    return detect_hailo_objects(provider, image_base64)


def _normalize_detections(raw_detections: tuple[dict[str, Any], ...], threshold: float) -> list[DetectedObject]:
    """Normalize raw backend detections into the shared schema."""
    normalized: list[DetectedObject] = []
    for raw in raw_detections:
        label = str(raw.get("label", "")).strip()
        if not label:
            continue
        confidence = _clamp_float(raw.get("confidence", 0.0))
        if confidence < threshold:
            continue
        normalized.append(
            DetectedObject(
                label=label,
                confidence=confidence,
                bbox=BoundingBox(
                    x=_clamp_float(raw.get("x", 0.0)),
                    y=_clamp_float(raw.get("y", 0.0)),
                    width=_clamp_float(raw.get("width", 0.0)),
                    height=_clamp_float(raw.get("height", 0.0)),
                ),
            )
        )
    return normalized


def _clamp_float(value: Any) -> float:
    """Clamp one numeric payload into the normalized 0..1 range."""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, numeric))
