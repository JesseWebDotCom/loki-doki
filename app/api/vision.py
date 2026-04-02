"""Vision-related API routes (detection, registration)."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.vision import (
    ObjectDetectionRequest,
    FaceDetectionRequest,
    FaceRegistrationFrameRequest,
    FaceRegistrationRequest,
)
from app.runtime import runtime_context
from app.orchestrator import route_object_detection, route_face_detection
from app.subsystems.live_video.face_recognition import (
    analyze_registration_frame,
    register_person,
    list_registered_people,
    delete_registered_person,
    list_registered_face_records,
    FaceRegistrationError,
)
from app.subsystems.image import ImageAnalysisError # Reuse for generic vision errors if needed
from app.api.utils import registered_person_payload, execution_meta

router = APIRouter(prefix="", tags=["vision"])


@router.post("/api/detect/objects")
def detect_objects_api(
    payload: ObjectDetectionRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Detect and label objects in one image."""
    del current_user
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_object_detection(
                 payload.image_data_url,
                 context["settings"]["profile"],
                 context["providers"],
                 payload.confidence_threshold,
            )
            return {
                "detections": [d.to_dict() for d in result.detections],
                "count": len(result.detections),
                "meta": {
                    "request_type": result.classification.request_type,
                    "route": result.classification.route,
                    "reason": result.classification.reason,
                    "execution": execution_meta(result.provider),
                },
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/detect/faces")
def detect_faces_api(
    payload: FaceDetectionRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Detect faces in one image."""
    del current_user
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_face_detection(
                payload.image_data_url,
                context["settings"]["profile"],
                context["providers"],
                payload.confidence_threshold,
            )
            return {
                "detections": [d.to_dict() for d in result.detections],
                "count": len(result.detections),
                "meta": {
                    "request_type": result.classification.request_type,
                    "route": result.classification.route,
                    "reason": result.classification.reason,
                    "execution": execution_meta(result.provider),
                },
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/people/faces")
def list_registered_people_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """List all locally registered people."""
    del current_user
    return {"people": [registered_person_payload(record) for record in list_registered_face_records()]}


@router.post("/api/people/faces/frame")
def analyze_face_registration_frame_api(
    payload: FaceRegistrationFrameRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Evaluate one live camera frame for person-registration quality."""
    del current_user
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            analysis = analyze_registration_frame(
                payload.image_data_url,
                context["settings"]["profile"],
                context["providers"],
                payload.mode,
            )
            return {
                "accepted": analysis.accepted,
                "guidance": analysis.guidance,
                "target_count": analysis.target_count,
                "face": None if analysis.face is None else analysis.face.to_dict(),
                "quality": None if analysis.quality is None else analysis.quality.to_dict(),
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/people/faces")
def register_person_api(
    payload: FaceRegistrationRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Register one person from a set of accepted face frames."""
    del current_user
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            record = register_person(
                payload.name,
                payload.frames,
                context["settings"]["profile"],
                context["providers"],
                payload.mode,
            )
            return {"person": registered_person_payload(record), "count": len(list_registered_people())}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/api/people/faces/{name}")
def delete_registered_person_api(
    name: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one locally registered person."""
    del current_user
    removed = delete_registered_person(name)
    if not removed:
        raise HTTPException(status_code=404, detail="Registered person not found.")
    return {"removed": True}
