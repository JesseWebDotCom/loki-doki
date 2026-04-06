import json
import os
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SETTINGS_FILE = "data/settings.json"

DEFAULT_SETTINGS = {
    "admin_prompt": "",
    "user_prompt": "",
    "piper_voice": "en_US-lessac-medium",
    "stt_model": "base",
    "read_aloud": True,
}


class SettingsUpdate(BaseModel):
    admin_prompt: str = ""
    user_prompt: str = ""
    piper_voice: str = "en_US-lessac-medium"
    stt_model: str = "base"
    read_aloud: bool = True


def _load_settings() -> dict:
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULT_SETTINGS)


def _save_settings(data: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(data, f, indent=2)


@router.get("")
async def get_settings():
    """Return current settings."""
    return _load_settings()


@router.put("")
async def update_settings(settings: SettingsUpdate):
    """Update settings and persist to disk."""
    data = settings.model_dump()
    _save_settings(data)
    return {"status": "saved", **data}
