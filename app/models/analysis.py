"""Analysis-related Pydantic models (image, video, document)."""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


class ImageAnalysisRequest(BaseModel):
    """Image-analysis payload."""
    image_data_url: str = Field(min_length=1)
    prompt: str = ""
    filename: str = ""
    chat_id: Optional[str] = None
    performance_profile_id: str = "fast"


class VideoAnalysisRequest(BaseModel):
    """Video-analysis payload."""
    frame_data_urls: list[str] = Field(min_length=1, max_length=6)
    prompt: str = ""
    filename: str = ""
    chat_id: Optional[str] = None
    performance_profile_id: str = "fast"


class DocumentAnalysisRequest(BaseModel):
    """Document-analysis payload."""
    document_text: str = Field(min_length=1, max_length=200_000)
    prompt: str = ""
    filename: str = ""
    chat_id: Optional[str] = None
    performance_profile_id: str = "fast"
