"""Face embedding, matching, and registration helpers."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Optional

from PIL import Image

from app.config import get_face_recognition_defaults
from app.subsystems.live_video.face_embedder import average_embeddings, cosine_similarity, embed_face, merge_embeddings
from app.subsystems.live_video.face_quality import (
    FaceQuality,
    measure_face_quality,
    passes_face_quality,
    registration_guidance,
)
from app.subsystems.live_video.face_registry import RegisteredFace, load_registered_faces, remove_registered_face, upsert_registered_face
from app.subsystems.live_video.face_cpu_detector import _decode_image

if TYPE_CHECKING:
    from app.subsystems.live_video.face_service import DetectedFace


REGISTRATION_FACE_CONFIDENCE_THRESHOLD = 0.2
REQUIRED_REGISTRATION_MODES = ("close_up", "far")


class FaceRegistrationError(RuntimeError):
    """Raised when a person registration request fails."""


@dataclass(frozen=True)
class FaceMatch:
    """Recognition result for one detected face."""

    name: Optional[str]
    score: Optional[float]


@dataclass(frozen=True)
class RegistrationFrameAnalysis:
    """Server-side evaluation of one registration frame."""

    face: Optional[DetectedFace]
    quality: Optional[FaceQuality]
    accepted: bool
    guidance: str
    mode: str
    target_count: int


def recognize_faces(
    image_base64: str,
    detections: tuple[DetectedFace, ...],
    profile: str,
) -> tuple[DetectedFace, ...]:
    """Annotate detected faces with recognition labels when possible."""
    registry = load_registered_faces()
    if not registry or not detections:
        return detections
    image = _decode_image(image_base64)
    annotated: list[DetectedFace] = []
    threshold = float(get_face_recognition_defaults(profile)["recognition_threshold"])
    for detection in detections:
        match = _match_detection(image, detection, registry, threshold)
        annotated.append(
            replace(
                detection,
                identity=match.name,
                match_score=match.score,
            )
        )
    return tuple(annotated)


def analyze_registration_frame(
    image_data_url: str,
    profile: str,
    providers: dict[str, Any],
    mode: str,
) -> RegistrationFrameAnalysis:
    """Analyze one live registration frame for quality and guidance."""
    from app.subsystems.live_video.face_service import detect_faces

    result = detect_faces(
        image_data_url,
        profile,
        providers,
        confidence_threshold=REGISTRATION_FACE_CONFIDENCE_THRESHOLD,
        use_motion_gate=False,
    )
    target_count = _target_count_for_mode(mode)
    if not result.detections:
        return RegistrationFrameAnalysis(
            face=None,
            quality=None,
            accepted=False,
            guidance="Step into view so I can see one face.",
            mode=mode,
            target_count=target_count,
        )
    face = max(result.detections, key=lambda item: item.bbox.width * item.bbox.height)
    image = _decode_image(image_data_url.split(",", 1)[1] if "," in image_data_url else image_data_url)
    quality = measure_face_quality(image, face, profile)
    accepted = passes_face_quality(quality, profile)
    return RegistrationFrameAnalysis(
        face=face,
        quality=quality,
        accepted=accepted,
        guidance=registration_guidance(quality, profile, mode, accepted),
        mode=mode,
        target_count=target_count,
    )


def register_person(
    name: str,
    frames: list[str],
    profile: str,
    providers: dict[str, Any],
    mode: str,
) -> RegisteredFace:
    """Build and store one identity vector from accepted registration frames."""
    cleaned_name = name.strip()
    if not cleaned_name:
        raise FaceRegistrationError("A person name is required.")
    embeddings: list[tuple[float, ...]] = []
    for frame in frames:
        analysis = analyze_registration_frame(frame, profile, providers, mode)
        if not analysis.accepted or analysis.face is None:
            continue
        image = _decode_image(frame.split(",", 1)[1] if "," in frame else frame)
        embeddings.append(embed_face(_crop_face(image, analysis.face)))
    minimum = min(10, _target_count_for_mode(mode))
    if len(embeddings) < minimum:
        raise FaceRegistrationError(f"Only {len(embeddings)} good face samples were captured. Need at least {minimum}.")
    fresh_record = RegisteredFace(
        name=cleaned_name,
        vector=average_embeddings(embeddings),
        sample_count=len(embeddings),
        modes=(mode,),
    )
    existing = _registered_face_by_name(cleaned_name)
    record = _merge_registered_face(existing, fresh_record) if existing is not None else fresh_record
    upsert_registered_face(record)
    return record


def list_registered_people() -> tuple[str, ...]:
    """Return registered names in display order."""
    return tuple(face.name for face in load_registered_faces())


def delete_registered_person(name: str) -> bool:
    """Delete one registered person."""
    return remove_registered_face(name)


def list_registered_face_records() -> tuple[RegisteredFace, ...]:
    """Return the full registered face records for UI/status use."""
    return load_registered_faces()


def registration_is_complete(record: RegisteredFace) -> bool:
    """Return whether one person has completed both enrollment phases."""
    return all(mode in record.modes for mode in REQUIRED_REGISTRATION_MODES)


def _match_detection(
    image: Image.Image,
    detection: DetectedFace,
    registry: tuple[RegisteredFace, ...],
    threshold: float,
) -> FaceMatch:
    """Return the best registry match for one detection."""
    try:
        embedding = embed_face(_crop_face(image, detection))
    except Exception:
        return FaceMatch(name=None, score=None)
    best_name: Optional[str] = None
    best_score: Optional[float] = None
    for record in registry:
        score = cosine_similarity(embedding, record.vector)
        if best_score is None or score > best_score:
            best_name = record.name
            best_score = score
    if best_score is None or best_score < threshold:
        return FaceMatch(name=None, score=best_score)
    return FaceMatch(name=best_name, score=best_score)


def _crop_face(image: Image.Image, detection: DetectedFace) -> Image.Image:
    """Crop one face bounding box from an image."""
    width, height = image.size
    left = max(0, min(width, int(round(detection.bbox.x * width))))
    top = max(0, min(height, int(round(detection.bbox.y * height))))
    right = max(left + 1, min(width, int(round((detection.bbox.x + detection.bbox.width) * width))))
    bottom = max(top + 1, min(height, int(round((detection.bbox.y + detection.bbox.height) * height))))
    return image.crop((left, top, right, bottom))


def _registered_face_by_name(name: str) -> Optional[RegisteredFace]:
    """Return one registered face by case-insensitive name."""
    target = name.strip().lower()
    if not target:
        return None
    for record in load_registered_faces():
        if record.name.lower() == target:
            return record
    return None


def _merge_registered_face(existing: RegisteredFace, fresh: RegisteredFace) -> RegisteredFace:
    """Merge one new registration into an existing identity profile."""
    merged_modes = tuple(dict.fromkeys(existing.modes + fresh.modes))
    existing_count = existing.sample_count or 1
    fresh_count = fresh.sample_count or 1
    merged_vector = merge_embeddings(existing.vector, existing_count, fresh.vector, fresh_count)
    return RegisteredFace(
        name=fresh.name,
        vector=merged_vector,
        sample_count=existing_count + fresh_count,
        modes=merged_modes,
    )


def _target_count_for_mode(mode: str) -> int:
    """Return the configured auto-capture target per mode."""
    return 15 if mode == "far" else 10
