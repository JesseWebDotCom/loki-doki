from fastapi import APIRouter
from pydantic import BaseModel, Field

from lokidoki.core.relationship_aliases import DEFAULT_RELATIONSHIP_ALIASES
from lokidoki.core.settings_store import (
    DEFAULT_SETTINGS,
    SETTINGS_FILE,
    load_settings,
    save_settings,
)
from lokidoki.core.log_buffer import set_log_level

router = APIRouter()


class SettingsUpdate(BaseModel):
    admin_prompt: str = ""
    user_prompt: str = ""
    piper_voice: str = "en_US-lessac-medium"
    stt_model: str = "base"
    read_aloud: bool = True
    speech_rate: float = 1.0
    sentence_pause: float = 0.4
    normalize_text: bool = True
    log_level: str = "INFO"
    relationship_aliases: dict[str, list[str]] = Field(
        default_factory=lambda: dict(DEFAULT_RELATIONSHIP_ALIASES)
    )


def _load_settings() -> dict:
    return load_settings()


def _save_settings(data: dict) -> None:
    save_settings(data)


@router.get("")
async def get_settings():
    """Return current settings."""
    return _load_settings()


@router.put("")
async def update_settings(settings: SettingsUpdate):
    """Update settings and persist to disk."""
    data = settings.model_dump()
    _save_settings(data)
    set_log_level(data["log_level"])
    return {"status": "saved", **data}
