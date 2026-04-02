"""Skill-related Pydantic models."""

from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class SkillInstallRequest(BaseModel):
    """Skill-install payload."""
    skill_id: str = Field(min_length=1)


class SkillAccountRequest(BaseModel):
    """Skill-account payload."""
    label: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    is_default: bool = False
    account_id: Optional[str] = None


class SkillRouteInspectRequest(BaseModel):
    """Skill-routing inspection payload."""
    message: str = Field(min_length=1)


class SkillTestRequest(BaseModel):
    """Skill test-run payload."""
    message: str = Field(min_length=1)


class SkillSharedContextRequest(BaseModel):
    """Skill shared-context payload."""
    values: dict[str, Any] = Field(default_factory=dict)
