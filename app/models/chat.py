"""Chat-related Pydantic models."""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field

ChatResponseStyle = Literal["brief", "balanced", "detailed"]


class ChatRequest(BaseModel):
    """Chat payload."""
    message: str = Field(min_length=1)
    chat_id: Optional[str] = None
    performance_profile_id: str = "fast"
    response_style: Optional[ChatResponseStyle] = None


class SmartRetryRequest(BaseModel):
    """Retry one saved assistant turn with the smarter model."""
    assistant_index: int = Field(ge=1)
    chat_id: Optional[str] = None
    response_style: Optional[ChatResponseStyle] = None


class ChatCreateRequest(BaseModel):
    """Create one chat."""
    title: str = ""
    character_id: Optional[str] = None
    project_id: Optional[str] = None


class ChatRenameRequest(BaseModel):
    """Rename one chat."""
    title: str = Field(min_length=1)
