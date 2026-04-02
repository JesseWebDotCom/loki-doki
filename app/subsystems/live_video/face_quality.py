"""Face quality and pose heuristics for registration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional, Union

from PIL import Image

from app.config import get_face_recognition_defaults
from app.providers.types import ProviderSpec
from app.subsystems.live_video.face_cpu_detector import detect_cpu_faces
from app.subsystems.live_video.service import BoundingBox

if TYPE_CHECKING:
    from app.subsystems.live_video.face_service import DetectedFace, FacePoint


@dataclass(frozen=True)
class FaceQuality:
    """Computed quality metrics for one face sample."""

    width_px: int
    height_px: int
    sharpness: float
    yaw: float
    pitch: float

    def to_dict(self) -> dict[str, Union[float, int]]:
        """Return a JSON-safe payload."""
        return {
            "width_px": self.width_px,
            "height_px": self.height_px,
            "sharpness": round(self.sharpness, 2),
            "yaw": round(self.yaw, 2),
            "pitch": round(self.pitch, 2),
        }


def measure_face_quality(image: Image.Image, detection: DetectedFace, profile: str) -> FaceQuality:
    """Measure size, sharpness, and rough pose for one face crop."""
    bbox = _bbox_in_pixels(detection.bbox, image)
    crop = image.crop((bbox[0], bbox[1], bbox[2], bbox[3]))
    yaw, pitch = estimate_face_pose(image, detection)
    return FaceQuality(
        width_px=max(0, bbox[2] - bbox[0]),
        height_px=max(0, bbox[3] - bbox[1]),
        sharpness=_laplacian_variance(crop),
        yaw=yaw,
        pitch=pitch,
    )


def passes_face_quality(quality: FaceQuality, profile: str) -> bool:
    """Return whether one sample satisfies the configured thresholds."""
    limits = get_face_recognition_defaults(profile)
    return (
        quality.width_px >= int(limits["min_face_size_px"])
        and quality.height_px >= int(limits["min_face_size_px"])
        and quality.sharpness >= float(limits["sharpness_threshold"])
        and abs(quality.yaw) < 45.0
        and abs(quality.pitch) < 45.0
    )


def estimate_face_pose(image: Image.Image, detection: DetectedFace) -> tuple[float, float]:
    """Estimate rough yaw/pitch from landmarks when available."""
    points = detection.landmarks
    if len(points) >= 5:
        return _pose_from_landmarks(points)
    cpu_face = _cpu_landmark_face(image, detection.bbox)
    if cpu_face is None or len(cpu_face.landmarks) < 5:
        return (0.0, 0.0)
    return _pose_from_landmarks(cpu_face.landmarks)


def registration_guidance(quality: FaceQuality, profile: str, mode: str, accepted: bool) -> str:
    """Return one short spoken guidance hint."""
    limits = get_face_recognition_defaults(profile)
    if accepted:
        return "Perfect, hold that."
    if quality.width_px < int(limits["min_face_size_px"]) or quality.height_px < int(limits["min_face_size_px"]):
        return "Move a little closer." if mode == "close_up" else "Stay in view and drift a little closer."
    if quality.sharpness < float(limits["sharpness_threshold"]):
        return "Hold still for a second."
    if quality.yaw <= -18.0:
        return "Turn left slowly."
    if quality.yaw >= 18.0:
        return "Turn right slowly."
    if quality.pitch <= -18.0:
        return "Tilt up a little."
    if quality.pitch >= 18.0:
        return "Tilt down a little."
    return "Keep moving naturally."


def _cpu_landmark_face(image: Image.Image, target_bbox: BoundingBox) -> Optional[DetectedFace]:
    """Use SCRFD landmarks as a fallback pose estimator."""
    import base64
    from io import BytesIO
    from app.subsystems.live_video.face_service import DetectedFace, FacePoint

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    provider = ProviderSpec(
        name="face_quality",
        backend="cpu_face_detector",
        model="scrfd_500m",
        acceleration="cpu",
    )
    matches = detect_cpu_faces(provider, encoded)
    if not matches:
        return None
    best = max(matches, key=lambda item: _overlap_score(target_bbox, item))
    landmarks = tuple(FacePoint(x=float(point["x"]), y=float(point["y"])) for point in best.get("landmarks", []))
    return DetectedFace(
        confidence=float(best.get("confidence", 0.0)),
        bbox=BoundingBox(
            x=float(best.get("x", 0.0)),
            y=float(best.get("y", 0.0)),
            width=float(best.get("width", 0.0)),
            height=float(best.get("height", 0.0)),
        ),
        landmarks=landmarks,
    )


def _bbox_in_pixels(bbox: BoundingBox, image: Image.Image) -> tuple[int, int, int, int]:
    """Convert one normalized box into a bounded pixel crop."""
    width, height = image.size
    left = max(0, min(width, int(round(bbox.x * width))))
    top = max(0, min(height, int(round(bbox.y * height))))
    right = max(left + 1, min(width, int(round((bbox.x + bbox.width) * width))))
    bottom = max(top + 1, min(height, int(round((bbox.y + bbox.height) * height))))
    return left, top, right, bottom


def _laplacian_variance(image: Image.Image) -> float:
    """Return a simple sharpness score using Laplacian variance."""
    from app.subsystems.live_video.cpu_detector import _numpy_module

    numpy = _numpy_module()
    gray = numpy.asarray(image.convert("L"))
    try:
        import cv2  # type: ignore
    except ImportError:
        return _laplacian_variance_without_cv2(gray, numpy)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _laplacian_variance_without_cv2(gray: Any, numpy: Any) -> float:
    """Return Laplacian variance without OpenCV so registration never hard-crashes."""
    padded = numpy.pad(gray.astype(numpy.float64), 1, mode="edge")
    laplacian = (
        padded[:-2, 1:-1]
        + padded[2:, 1:-1]
        + padded[1:-1, :-2]
        + padded[1:-1, 2:]
        - (4.0 * padded[1:-1, 1:-1])
    )
    return float(laplacian.var())


def _pose_from_landmarks(points: tuple[FacePoint, ...]) -> tuple[float, float]:
    """Estimate rough face yaw/pitch from five-point landmarks."""
    left_eye, right_eye, nose, left_mouth, right_mouth = points[:5]
    eye_center_x = (left_eye.x + right_eye.x) / 2.0
    eye_center_y = (left_eye.y + right_eye.y) / 2.0
    mouth_center_x = (left_mouth.x + right_mouth.x) / 2.0
    mouth_center_y = (left_mouth.y + right_mouth.y) / 2.0
    eye_span = max(abs(right_eye.x - left_eye.x), 0.0001)
    face_span = max(abs(mouth_center_y - eye_center_y), 0.0001)
    yaw = ((nose.x - eye_center_x) / eye_span) * 90.0
    pitch = ((nose.y - ((eye_center_y + mouth_center_y) / 2.0)) / face_span) * 90.0
    return yaw, pitch


def _overlap_score(target: BoundingBox, candidate: dict[str, Any]) -> float:
    """Return a lightweight IoU score for one candidate face."""
    left = max(target.x, float(candidate.get("x", 0.0)))
    top = max(target.y, float(candidate.get("y", 0.0)))
    right = min(target.x + target.width, float(candidate.get("x", 0.0)) + float(candidate.get("width", 0.0)))
    bottom = min(target.y + target.height, float(candidate.get("y", 0.0)) + float(candidate.get("height", 0.0)))
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    target_area = target.width * target.height
    candidate_area = float(candidate.get("width", 0.0)) * float(candidate.get("height", 0.0))
    union = max(target_area + candidate_area - intersection, 0.0001)
    return intersection / union
