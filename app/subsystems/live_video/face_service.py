"""Business logic for Phase 7 face detection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Union

from app.config import get_profile_defaults
from app.providers.types import ProviderSpec
from app.subsystems.live_video.face_recognition import recognize_faces
from app.subsystems.live_video.hailo_face_detector import detect_hailo_faces
from app.subsystems.image.vision import VisionRequestError, extract_image_payload
from app.subsystems.live_video.face_cpu_detector import detect_cpu_faces
from app.subsystems.live_video.motion_gate import detect_with_motion_gate
from app.subsystems.live_video.onnx_face_detector import detect_onnx_faces
from app.subsystems.text.client import ProviderRequestError


class FaceDetectionError(RuntimeError):
    """Raised when face detection cannot be completed."""


@dataclass(frozen=True)
class FacePoint:
    """One normalized face landmark."""

    x: float
    y: float

    def to_dict(self) -> dict[str, float]:
        """Return a JSON-safe payload."""
        return {"x": round(self.x, 4), "y": round(self.y, 4)}


@dataclass(frozen=True)
class DetectedFace:
    """One normalized face detection."""

    confidence: float
    bbox: Any
    landmarks: tuple[FacePoint, ...]
    identity: Optional[str] = None
    match_score: Optional[float] = None

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-safe payload."""
        payload: dict[str, object] = {
            "confidence": round(self.confidence, 4),
            "bbox": self.bbox.to_dict(),
            "landmarks": [point.to_dict() for point in self.landmarks],
        }
        if self.identity is not None:
            payload["identity"] = self.identity
        if self.match_score is not None:
            payload["match_score"] = round(self.match_score, 4)
        return payload


@dataclass(frozen=True)
class FaceDetectionResult:
    """Face detections plus execution metadata."""

    detections: tuple[DetectedFace, ...]
    provider: ProviderSpec


def detect_faces(
    image_data_url: str,
    profile: str,
    providers: dict[str, ProviderSpec],
    confidence_threshold: float = 0.5,
    use_motion_gate: bool = True,
) -> FaceDetectionResult:
    """Return normalized face detections for one uploaded frame."""
    from app.subsystems.live_video.service import BoundingBox

    try:
        image_base64 = extract_image_payload(image_data_url)
        provider = select_face_detector_provider(profile, providers)
    except VisionRequestError as exc:
        raise FaceDetectionError(str(exc)) from exc
    try:
        detections = _normalize_faces(
            _detect_faces_with_strategy(profile, image_base64, provider, use_motion_gate),
            confidence_threshold,
            BoundingBox,
        )
        detections = list(recognize_faces(image_base64, tuple(detections), profile))
        return FaceDetectionResult(detections=tuple(detections), provider=provider)
    except ProviderRequestError as exc:
        fallback_provider = fallback_provider_for(profile, provider)
        if fallback_provider is not None:
            try:
                detections = _normalize_faces(
                    _detect_faces_with_strategy(profile, image_base64, fallback_provider, use_motion_gate),
                    confidence_threshold,
                    BoundingBox,
                )
                detections = list(recognize_faces(image_base64, tuple(detections), profile))
                return FaceDetectionResult(detections=tuple(detections), provider=fallback_provider)
            except ProviderRequestError as fallback_exc:
                raise FaceDetectionError(provider_failure_message(fallback_provider, profile, str(fallback_exc))) from fallback_exc
        raise FaceDetectionError(provider_failure_message(provider, profile, str(exc))) from exc


def select_face_detector_provider(profile: str, providers: dict[str, ProviderSpec]) -> ProviderSpec:
    """Return the active face-detection provider or a configured fallback."""
    provider = providers["face_detector"]
    if provider.backend in {"cpu_face_detector", "hailort", "onnx_face_detector"}:
        return provider
    fallback_provider = fallback_provider_for(profile, provider)
    if fallback_provider is not None:
        return fallback_provider
    raise VisionRequestError(f"Face detection is unavailable on the {profile} profile because {provider.backend} is not ready.")


def fallback_provider_for(profile: str, provider: ProviderSpec) -> Optional[ProviderSpec]:
    """Return the configured CPU fallback face detector."""
    if provider.fallback_backend != "cpu_face_detector":
        return None
    fallback_profile = "pi_cpu" if profile in {"pi_cpu", "pi_hailo"} else "mac"
    fallback_model = provider.fallback_model or get_profile_defaults(fallback_profile)["face_detector_model"]
    return ProviderSpec(
        name="face_detector_fallback",
        backend="cpu_face_detector",
        model=fallback_model,
        acceleration="cpu",
        notes="CPU fallback active for face detection.",
    )


def provider_failure_message(provider: ProviderSpec, profile: str, detail: str) -> str:
    """Return a user-facing face-detection error."""
    return (
        f"Face detection is unavailable on the {profile} profile. "
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
        f"{profile}:face_detector",
        image_base64,
        lambda: _detect_with_provider(provider, image_base64),
    )


def _detect_faces_with_strategy(
    profile: str,
    image_base64: str,
    provider: ProviderSpec,
    use_motion_gate: bool,
) -> tuple[dict[str, Any], ...]:
    """Run face detection with or without the shared motion gate."""
    if use_motion_gate:
        return _detect_with_motion_gate(profile, image_base64, provider)
    return _detect_with_provider(provider, image_base64)


def _detect_with_provider(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Dispatch one frame to the active face-detection backend."""
    if provider.backend == "hailort":
        return request_hailo_face_detections(provider, image_base64)
    if provider.backend == "onnx_face_detector":
        return request_onnx_face_detections(provider, image_base64)
    if provider.backend == "cpu_face_detector":
        return request_cpu_face_detections(provider, image_base64)
    raise ProviderRequestError(f"Unsupported face-detection backend '{provider.backend}'.")


def request_cpu_face_detections(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Return CPU face detections for one frame."""
    return detect_cpu_faces(provider, image_base64)


def request_hailo_face_detections(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Return Hailo face detections for one frame."""
    return detect_hailo_faces(provider, image_base64)


def request_onnx_face_detections(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Return ONNX/CoreML face detections for one frame."""
    return detect_onnx_faces(provider, image_base64)


def _normalize_faces(raw_detections: tuple[dict[str, Any], ...], threshold: float, bbox_type: Any) -> list[DetectedFace]:
    """Normalize raw backend detections into the shared face schema."""
    normalized: list[DetectedFace] = []
    for raw in raw_detections:
        confidence = _clamp_float(raw.get("confidence", 0.0))
        if confidence < threshold:
            continue
        landmarks = tuple(
            FacePoint(x=_clamp_float(point.get("x", 0.0)), y=_clamp_float(point.get("y", 0.0)))
            for point in raw.get("landmarks", [])
        )
        normalized.append(
            DetectedFace(
                confidence=confidence,
                bbox=bbox_type(
                    x=_clamp_float(raw.get("x", 0.0)),
                    y=_clamp_float(raw.get("y", 0.0)),
                    width=_clamp_float(raw.get("width", 0.0)),
                    height=_clamp_float(raw.get("height", 0.0)),
                ),
                landmarks=landmarks,
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
