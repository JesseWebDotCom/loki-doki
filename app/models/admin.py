"""Admin-related Pydantic models."""

from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class AdminUserRoleRequest(BaseModel):
    """Admin-user role update payload."""
    is_admin: bool


class AdminUserPasswordRequest(BaseModel):
    """Admin-user password update payload."""
    password: str = Field(min_length=8)


class AccountSettingsRequest(BaseModel):
    """Account settings payload."""
    name: Optional[str] = None
    default_character_id: Optional[str] = None
    character_feature_enabled: Optional[bool] = None
    auto_update_skills: Optional[bool] = None


class PromptPolicyRequest(BaseModel):
    """Account prompt policy payload."""
    core_safety_prompt: Optional[str] = None
    account_policy_prompt: Optional[str] = None
    proactive_chatter_enabled: Optional[bool] = None


class UserPromptOverrideRequest(BaseModel):
    """Admin-managed per-user prompt override payload."""
    admin_prompt: str = ""
    blocked_topics: list[str] = Field(default_factory=list)


class AdminPromptLabRequest(BaseModel):
    """Admin prompt-lab payload."""
    user_id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    use_skills: bool = True
    enabled_layers: dict[str, bool] = Field(default_factory=dict)
    layer_overrides: dict[str, str] = Field(default_factory=dict)


class AdminPromptLabCompileRequest(BaseModel):
    """Admin prompt-compile preview payload."""
    user_id: str = Field(min_length=1)
    enabled_layers: dict[str, bool] = Field(default_factory=dict)
    layer_overrides: dict[str, str] = Field(default_factory=dict)
