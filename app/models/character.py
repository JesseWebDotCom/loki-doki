"""Character-related Pydantic models."""

from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class CharacterSettingsRequest(BaseModel):
    """User character settings payload."""
    character_enabled: Optional[bool] = None
    active_character_id: Optional[str] = None
    user_prompt: Optional[str] = None
    care_profile_id: Optional[str] = None
    character_customizations: dict[str, str] = Field(default_factory=dict)


class CharacterInstallRequest(BaseModel):
    """Character install payload."""
    character_id: str = Field(min_length=1)


class CharacterUpdateRequest(BaseModel):
    """Editable character metadata payload."""
    name: str = Field(min_length=1)
    description: str = ""
    teaser: str = ""
    phonetic_spelling: str = ""
    logo: str = ""
    system_prompt: str = ""
    default_voice: str = ""
    default_voice_download_url: str = ""
    default_voice_config_download_url: str = ""
    default_voice_source_name: str = ""
    default_voice_config_source_name: str = ""
    default_voice_upload_data_url: str = ""
    default_voice_config_upload_data_url: str = ""
    wakeword_model_id: str = ""
    wakeword_download_url: str = ""
    wakeword_source_name: str = ""
    wakeword_upload_data_url: str = ""
    identity_key: str = ""
    domain: str = ""
    behavior_style: str = ""
    preferred_response_style: str = "balanced"
    voice_model: str = ""
    character_editor: dict[str, Any] = Field(default_factory=dict)


class CatalogRepositoryPayload(BaseModel):
    """Repository catalog metadata payload."""
    title: str = ""
    description: str = ""
    repo_url: str = ""
    source_repo_url: str = ""
    index_url: str = ""


class CharacterImportRequest(BaseModel):
    """Portable character package payload."""
    package: dict[str, Any]


class CareProfileRequest(BaseModel):
    """Care profile payload."""
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    tone: str = ""
    vocabulary: str = "standard"
    sentence_length: str = "medium"
    response_style: str = "balanced"
    blocked_topics: list[str] = Field(default_factory=list)
    safe_messaging: bool = True
    max_response_tokens: int = Field(default=160, ge=32, le=512)
    builtin: bool = False
