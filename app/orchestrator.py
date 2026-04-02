"""Request orchestration for the active profile."""

from __future__ import annotations

from typing import Any, Optional
from collections.abc import Iterator
from dataclasses import dataclass

from app.classifier import Classification, classify_message
from app.providers.types import ProviderSpec
from app.subsystems.character import CharacterRenderingContext
from app.subsystems.image import analyze_image
from app.subsystems.live_video import DetectedFace, DetectedObject, detect_faces, detect_objects
from app.subsystems.text import generate_text_reply, stream_text_reply
from app.subsystems.video import analyze_video

MAX_DOCUMENT_CHARS = 12_000


@dataclass(frozen=True)
class OrchestratedResponse:
    """Placeholder response payload for the UI."""

    classification: Classification
    reply: str
    provider: ProviderSpec
    parsed: Optional[object] = None
    debug: Optional[dict[str, object]] = None


@dataclass(frozen=True)
class OrchestratedStream:
    """Streaming response payload for the UI."""

    classification: Classification
    provider: ProviderSpec
    chunks: Iterator[str]
    parsed: Optional[object] = None
    debug: Optional[dict[str, object]] = None


@dataclass(frozen=True)
class OrchestratedImageResponse:
    """Image-analysis response payload for the UI."""

    classification: Classification
    reply: str
    provider: ProviderSpec


@dataclass(frozen=True)
class OrchestratedVideoResponse:
    """Video-analysis response payload for the UI."""

    classification: Classification
    reply: str
    provider: ProviderSpec


@dataclass(frozen=True)
class OrchestratedDocumentResponse:
    """Document-analysis response payload for the UI."""

    classification: Classification
    reply: str
    provider: ProviderSpec


@dataclass(frozen=True)
class OrchestratedImageGenerationResponse:
    """Image-generation response payload for the UI."""

    classification: Classification
    reply: str
    provider: ProviderSpec


@dataclass(frozen=True)
class OrchestratedObjectDetectionResponse:
    """Object-detection response payload for the UI."""

    classification: Classification
    detections: tuple[DetectedObject, ...]
    provider: ProviderSpec


@dataclass(frozen=True)
class OrchestratedFaceDetectionResponse:
    """Face-detection response payload for the UI."""

    classification: Classification
    detections: tuple[DetectedFace, ...]
    provider: ProviderSpec


def route_message(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
    rendering_context: Optional[CharacterRenderingContext] = None,
    dynamic_context: str = "",
    response_style: Optional[str] = None,
    include_prompt_debug: bool = False,
) -> OrchestratedResponse:
    """Route a message through the active profile/provider map."""
    classification = classify_message(message)
    result = generate_text_reply(
        message,
        username,
        profile,
        history,
        providers,
        classification,
        rendering_context=rendering_context,
        dynamic_context=dynamic_context,
        response_style=response_style,
        include_prompt_debug=include_prompt_debug,
    )
    return OrchestratedResponse(
        classification=classification,
        reply=result.reply,
        provider=result.provider,
        parsed=result.parsed,
        debug=result.debug,
    )


def route_message_stream(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
    rendering_context: Optional[CharacterRenderingContext] = None,
    dynamic_context: str = "",
    response_style: Optional[str] = None,
) -> OrchestratedStream:
    """Route a message and stream the active profile/provider response."""
    classification = classify_message(message)
    result = stream_text_reply(
        message,
        username,
        profile,
        history,
        providers,
        classification,
        rendering_context=rendering_context,
        dynamic_context=dynamic_context,
        response_style=response_style,
    )
    return OrchestratedStream(
        classification=classification,
        provider=result.provider,
        chunks=result.chunks,
        parsed=result.parsed,
        debug=result.debug,
    )


def route_image_analysis(
    image_data_url: str,
    prompt: str,
    profile: str,
    providers: dict[str, ProviderSpec],
) -> OrchestratedImageResponse:
    """Route one uploaded image through the active vision provider."""
    result = analyze_image(image_data_url, prompt, profile, providers)
    classification = Classification(
        request_type="image_analysis",
        route=result.provider.name,
        reason="Uploaded image requested for media analysis.",
    )
    return OrchestratedImageResponse(classification=classification, reply=result.reply, provider=result.provider)


def route_image_generation(
    prompt: str,
    profile: str,
    config: Any,
    image_data_url: Optional[str] = None,
) -> OrchestratedImageGenerationResponse:
    """Route one request through the image generation model (txt2img or img2img)."""
    from app.subsystems.image import generate_image
    from app.providers.types import ProviderSpec
    
    # Provider spec placeholder since it's hardcoded to diffusers locally right now
    provider = ProviderSpec(
        name="stable_diffusion_lcm",
        backend="diffusers",
        model="runwayml/stable-diffusion-v1-5",
        acceleration="mps_or_cpu",
    )
    
    reply = generate_image(prompt, config, profile, image_data_url)
    classification = Classification(
        request_type="image_generation",
        route=provider.name,
        reason="Image generation or manipulation requested.",
    )
    return OrchestratedImageGenerationResponse(classification=classification, reply=f"![Generated Image]({reply})", provider=provider)


def route_video_analysis(
    frame_data_urls: list[str],
    prompt: str,
    profile: str,
    providers: dict[str, ProviderSpec],
) -> OrchestratedVideoResponse:
    """Route one uploaded video through the active vision provider."""
    result = analyze_video(frame_data_urls, prompt, profile, providers)
    classification = Classification(
        request_type="video_analysis",
        route=result.provider.name,
        reason="Uploaded video requested for sampled-frame analysis.",
    )
    return OrchestratedVideoResponse(classification=classification, reply=result.reply, provider=result.provider)


def route_document_analysis(
    document_text: str,
    prompt: str,
    filename: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
) -> OrchestratedDocumentResponse:
    """Route one uploaded text document through the thinking text model."""
    document_prompt = _document_analysis_prompt(document_text, prompt, filename)
    classification = Classification(
        request_type="document_analysis",
        route="thinking_qwen",
        reason="Uploaded document requested for text analysis.",
    )
    result = generate_text_reply(document_prompt, username, profile, history, providers, classification)
    return OrchestratedDocumentResponse(classification=classification, reply=result.reply, provider=result.provider)


def route_object_detection(
    image_data_url: str,
    profile: str,
    providers: dict[str, ProviderSpec],
    confidence_threshold: float = 0.2,
) -> OrchestratedObjectDetectionResponse:
    """Route one uploaded frame through the active object-detection provider."""
    result = detect_objects(image_data_url, profile, providers, confidence_threshold)
    classification = Classification(
        request_type="object_detection",
        route=result.provider.name,
        reason="Uploaded frame requested for object detection.",
    )
    return OrchestratedObjectDetectionResponse(
        classification=classification,
        detections=result.detections,
        provider=result.provider,
    )


def route_face_detection(
    image_data_url: str,
    profile: str,
    providers: dict[str, ProviderSpec],
    confidence_threshold: float = 0.5,
) -> OrchestratedFaceDetectionResponse:
    """Route one uploaded frame through the active face-detection provider."""
    result = detect_faces(image_data_url, profile, providers, confidence_threshold)
    classification = Classification(
        request_type="face_detection",
        route=result.provider.name,
        reason="Uploaded frame requested for face detection.",
    )
    return OrchestratedFaceDetectionResponse(
        classification=classification,
        detections=result.detections,
        provider=result.provider,
    )


def _document_analysis_prompt(document_text: str, prompt: str, filename: str) -> str:
    """Build the prompt for uploaded document analysis."""
    trimmed = document_text.strip()
    excerpt = trimmed[:MAX_DOCUMENT_CHARS]
    truncated_note = ""
    if len(trimmed) > MAX_DOCUMENT_CHARS:
        truncated_note = (
            f"\n\nNote: Only the first {MAX_DOCUMENT_CHARS} characters of the document were included."
        )
    instruction = prompt.strip() or "Summarize this document and explain its main point."
    label = filename.strip() or "uploaded document"
    return (
        f"{instruction}\n\n"
        f"Document: {label}\n"
        "Analyze the text below and answer directly.\n\n"
        "Document text:\n"
        f"{excerpt}{truncated_note}"
    )
