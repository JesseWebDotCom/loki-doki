from __future__ import annotations

import json
import os
from copy import deepcopy

from lokidoki.core.relationship_aliases import DEFAULT_RELATIONSHIP_ALIASES


SETTINGS_FILE = "data/settings.json"

DEFAULT_SETTINGS = {
    "admin_prompt": "",
    "user_prompt": "",
    "piper_voice": "en_US-lessac-medium",
    "stt_model": "base",
    "read_aloud": True,
    "speech_rate": 1.0,
    "sentence_pause": 0.4,
    "normalize_text": True,
    "relationship_aliases": DEFAULT_RELATIONSHIP_ALIASES,
}


def load_settings() -> dict:
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except (json.JSONDecodeError, OSError):
            pass
    return deepcopy(DEFAULT_SETTINGS)


def save_settings(data: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(data, f, indent=2)
