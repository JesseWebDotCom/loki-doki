"""Live-video and object-detection helpers."""

from app.subsystems.live_video.service import (
    BoundingBox,
    DetectedObject,
    ObjectDetectionError,
    ObjectDetectionResult,
    detect_objects,
)
from app.subsystems.live_video.face_service import (
    DetectedFace,
    FaceDetectionError,
    FaceDetectionResult,
    FacePoint,
    detect_faces,
)

__all__ = [
    "BoundingBox",
    "DetectedFace",
    "DetectedObject",
    "FaceDetectionError",
    "FaceDetectionResult",
    "FacePoint",
    "ObjectDetectionError",
    "ObjectDetectionResult",
    "detect_faces",
    "detect_objects",
]
