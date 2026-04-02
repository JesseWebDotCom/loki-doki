"""Analysis-related API routes (vision, documents)."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.analysis import (
    ImageAnalysisRequest,
    VideoAnalysisRequest,
    DocumentAnalysisRequest,
)
from app.models.vision import (
     ObjectDetectionRequest,
     FaceDetectionRequest,
     FaceRegistrationFrameRequest,
     FaceRegistrationRequest,
)
from app.runtime import runtime_context
from app.orchestrator import (
    route_image_analysis,
    route_video_analysis,
    route_document_analysis,
    route_object_detection,
    route_face_detection,
)
from app.subsystems.image import ImageAnalysisError
from app.subsystems.video import VideoAnalysisError
from app.subsystems.live_video.face_recognition import (
    analyze_registration_frame,
    register_person,
    list_registered_people,
    delete_registered_person,
    list_registered_face_records,
    FaceRegistrationError,
)
from app.api.utils import registered_person_payload, execution_meta

router = APIRouter(prefix="", tags=["analysis"])


@router.post("/api/analysis/image")
def image_analysis_api(
    payload: ImageAnalysisRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Process one image analysis turn."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_image_analysis(
                payload.image_data_url,
                payload.prompt,
                current_user["display_name"],
                context["settings"]["profile"],
                context["providers"],
                payload.filename,
                APP_CONFIG,
            )
            return {
                "reply": result.reply,
                "classification": result.classification,
                "execution": execution_meta(result.provider),
            }
        except ImageAnalysisError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/analysis/video")
def video_analysis_api(
    payload: VideoAnalysisRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Process one multi-frame video analysis turn."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_video_analysis(
                payload.frame_data_urls,
                payload.prompt,
                current_user["display_name"],
                context["settings"]["profile"],
                context["providers"],
                payload.filename,
                APP_CONFIG,
            )
            return {
                "reply": result.reply,
                "classification": result.classification,
                "execution": execution_meta(result.provider),
            }
        except VideoAnalysisError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/analysis/document")
def document_analysis_api(
    payload: DocumentAnalysisRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Process one text-document analysis turn."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_document_analysis(
                payload.document_text,
                payload.prompt,
                current_user["display_name"],
                context["settings"]["profile"],
                context["providers"],
                payload.filename,
                APP_CONFIG,
            )
            return {
                "reply": result.reply,
                "classification": result.classification,
                "execution": execution_meta(result.provider),
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/vision/detect-objects")
def object_detection_api(
    payload: ObjectDetectionRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Detect and label objects in one image."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_object_detection(
                payload.image_data_url,
                payload.confidence_threshold,
                context["settings"]["profile"],
                context["providers"],
                APP_CONFIG,
            )
            return {
                "objects": result["objects"],
                "execution": result["execution"],
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/vision/detect-faces")
def face_detection_api(
    payload: FaceDetectionRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Detect faces in one image."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = route_face_detection(
                payload.image_data_url,
                payload.confidence_threshold,
                context["settings"]["profile"],
                context["providers"],
                APP_CONFIG,
            )
            return {
                "faces": result["faces"],
                "execution": result["execution"],
            }
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/vision/registered-people")
def get_registered_people_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return all people registered for local face recognition."""
    del current_user
    with connection_scope() as connection:
        people = list_registered_people(connection)
        return {"people": [registered_person_payload(p) for p in people]}


@router.post("/api/vision/registration/evaluate-frame")
def evaluate_registration_frame_api(
    payload: FaceRegistrationFrameRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Analyze one registration frame for face quality."""
    del current_user
    with connection_scope() as connection:
        try:
            analysis = analyze_registration_frame(payload.image_data_url, payload.mode)
            return {"ok": True, "analysis": analysis}
        except FaceRegistrationError as exc:
            return {"ok": False, "error": str(exc)}


@router.post("/api/vision/registration/register")
def finalize_registration_api(
    payload: FaceRegistrationRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Save a person to the local face recognition store."""
    del current_user
    with connection_scope() as connection:
        try:
            person = register_person(connection, payload.name, payload.mode, payload.frames)
            return {"ok": True, "person": registered_person_payload(person)}
        except FaceRegistrationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/vision/registration/records")
def list_registration_records_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """List all registered face recognition metadata."""
    del current_user
    with connection_scope() as connection:
        records = list_registered_face_records(connection)
        return {"records": records}


@router.delete("/api/vision/registered-people/{name}")
def delete_person_api(
    name: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one person from the local face recognition store."""
    del current_user
    with connection_scope() as connection:
        delete_registered_person(connection, name)
        return {"ok": True}
