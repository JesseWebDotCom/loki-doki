"""Vision-related Pydantic models (object detection, face recognition)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ObjectDetectionRequest(BaseModel):
    """Object-detection payload."""
    image_data_url: str = Field(min_length=1)
    confidence_threshold: float = Field(default=0.2, ge=0.0, le=1.0)


class FaceDetectionRequest(BaseModel):
    """Face-detection payload."""
    image_data_url: str = Field(min_length=1)
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)


class FaceRegistrationFrameRequest(BaseModel):
    """Registration frame-evaluation payload."""
    image_data_url: str = Field(min_length=1)
    mode: str = Field(default="close_up", pattern="^(close_up|far)$")


class FaceRegistrationRequest(BaseModel):
    """Finalize person registration from captured frames."""
    name: str = Field(min_length=1)
    mode: str = Field(default="close_up", pattern="^(close_up|far)$")
    frames: list[str] = Field(min_length=1, max_length=24)
