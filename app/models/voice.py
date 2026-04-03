"""Voice-related Pydantic models."""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field

VoiceResponseStyle = Literal["brief"]


class WakewordSettingsRequest(BaseModel):
    """Wakeword settings payload."""
    enabled: Optional[bool] = None
    model_id: Optional[str] = None
    threshold: Optional[float] = None


class PiperInstallRequest(BaseModel):
    """Piper voice install payload."""
    voice_id: str = Field(min_length=1)


class CustomPiperInstallRequest(BaseModel):
    """Custom Piper voice install payload."""
    voice_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    model_url: str = ""
    config_url: str = ""
    model_data_url: str = ""
    config_data_url: str = ""
    model_source_name: str = ""
    config_source_name: str = ""
    description: str = ""
    language: str = ""
    quality: str = ""
    gender: str = ""


class UpdateCustomPiperVoiceRequest(BaseModel):
    """Custom Piper voice metadata update payload."""
    label: str = Field(min_length=1)
    description: str = ""
    model_url: str = ""
    config_url: str = ""
    language: str = ""
    quality: str = ""
    gender: str = ""


class VoiceSpeakRequest(BaseModel):
    """Voice synthesis payload."""
    text: str = Field(min_length=1)
    voice_id: Optional[str] = None


class VoiceStreamRequest(BaseModel):
    """Streaming voice synthesis payload."""
    text: str = Field(min_length=1)
    voice_id: Optional[str] = None


class VoiceTranscribeRequest(BaseModel):
    """Push-to-talk transcription payload."""
    audio_base64: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)


class VoiceLiveTranscribeRequest(BaseModel):
    """Incremental push-to-talk transcription payload."""
    audio_base64: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)
    sequence: int = Field(ge=0, default=0)
    is_final: bool = False


class VoiceChatRequest(BaseModel):
    """Recorded push-to-talk request payload."""
    audio_base64: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)
    chat_id: Optional[str] = None
    response_style: VoiceResponseStyle = "brief"


class WakewordDetectRequest(BaseModel):
    """Wakeword audio chunk payload."""
    audio_base64: str = Field(min_length=1)
    sample_rate: int = Field(gt=0)
