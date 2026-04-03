"""Memory-related Pydantic models."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator


def _normalize_scope(value: str) -> str:
    """Normalize legacy aliases into one supported scope label."""
    cleaned = value.strip().lower()
    if cleaned == "user":
        return "person"
    if cleaned not in {"session", "person", "household"}:
        raise ValueError("scope must be session, person, or household")
    return cleaned


class MemorySyncRequest(BaseModel):
    """Payload for child nodes pulling a master delta."""

    node_id: str = Field(min_length=1)
    watermark: str


class MemoryWriteRequest(BaseModel):
    """Payload for writing one scoped memory entry."""

    scope: str = Field(min_length=1)
    key: str = Field(min_length=1)
    value: str = Field(min_length=1)
    chat_id: Optional[str] = None
    character_id: Optional[str] = None

    @field_validator("scope")
    @classmethod
    def validate_scope(cls, value: str) -> str:
        """Normalize supported memory scope aliases."""
        return _normalize_scope(value)


class MemoryAddRequest(BaseModel):
    """Backward-compatible payload for household memory creation."""

    key: str = Field(min_length=1)
    value: str = Field(min_length=1)


class MemoryDeleteRequest(BaseModel):
    """Query-compatible payload for deleting one scoped memory entry."""

    scope: str = Field(min_length=1)
    key: str = Field(min_length=1)
    chat_id: Optional[str] = None
    character_id: Optional[str] = None

    @field_validator("scope")
    @classmethod
    def validate_scope(cls, value: str) -> str:
        """Normalize supported memory scope aliases."""
        return _normalize_scope(value)


class MemoryIndexRequest(BaseModel):
    """Payload for indexing a document into long-term archival memory."""

    content: str = Field(min_length=1)
    source: str = Field(default="user_upload")
    character_id: Optional[str] = "system"
    chunk_size: int = 500
    overlap: int = 150
