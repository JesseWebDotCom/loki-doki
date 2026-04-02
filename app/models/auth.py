"""Auth-related Pydantic models."""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    """Login payload."""
    username: str
    password: str


class RegisterRequest(BaseModel):
    """Registration payload."""
    username: str
    display_name: str = Field(min_length=1)
    password: str = Field(min_length=8)


class ProfileSettingsRequest(BaseModel):
    """Self-service profile update payload."""
    display_name: Optional[str] = None
    current_password: Optional[bool] = None
    new_password: Optional[str] = None
