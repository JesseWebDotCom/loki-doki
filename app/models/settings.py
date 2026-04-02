"""Settings-related Pydantic models."""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class SettingsRequest(BaseModel):
    """General settings payload."""
    theme: Optional[str] = None
    debug_mode: Optional[bool] = None
    voice_reply_enabled: Optional[bool] = None
    voice_source: Optional[str] = None
    browser_voice_uri: Optional[str] = None
    piper_voice_id: Optional[str] = None
    barge_in_enabled: Optional[bool] = None


class ProfileRequest(BaseModel):
    """Global profile update payload."""
    profile: str
