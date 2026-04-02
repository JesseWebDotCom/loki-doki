"""Internal helpers for the character subsystem."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Union

from app.config import AppConfig
from app.subsystems.character.models import CharacterDefinition


def row_to_definition(row: Union[dict[str, Any], sqlite3.Row]) -> CharacterDefinition:
    """Return one loaded character definition from a database row."""
    # Handle both dict-like and Row objects
    data = dict(row)
    return CharacterDefinition(
        character_id=str(data["character_id"]),
        name=str(data["name"]),
        version=str(data["version"]),
        source=str(data["source"]),
        system_prompt=str(data["system_prompt"]),
        default_voice=str(data["default_voice"]),
        default_voice_download_url=str(data["default_voice_download_url"] or ""),
        default_voice_config_download_url=str(data["default_voice_config_download_url"] or ""),
        default_voice_source_name=str(data["default_voice_source_name"] or ""),
        default_voice_config_source_name=str(data["default_voice_config_source_name"] or ""),
        wakeword_model_id=str(data["wakeword_model_id"] or ""),
        wakeword_download_url=str(data["wakeword_download_url"] or ""),
        wakeword_source_name=str(data["wakeword_source_name"] or ""),
        capabilities=json.loads(str(data["capabilities_json"] or "{}")),
        logo=str(data["logo"]),
        description=str(data["description"] or ""),
        path=str(data["path"]),
        enabled=bool(data["enabled"]),
        builtin=bool(data["builtin"]),
    )


def validate_manifest_path(path: Path, config: AppConfig) -> None:
    """Raise ValueError when the manifest path is not within the repository or built-ins."""
    resolved = path.resolve()
    if not (
        resolved.is_relative_to(config.characters_builtin_dir.resolve())
        or resolved.is_relative_to(config.characters_repository_dir.resolve())
    ):
        raise ValueError(f"Path {path} is not within the authorized character directories.")


def normalize_character_id(raw_id: str) -> str:
    """Return a lower-case alphanumeric-and-underscores id."""
    return re.sub(r"[^a-z0-9_]+", "_", str(raw_id).lower()).strip("_")


def prompt_sentences(text: str) -> list[str]:
    """Return individual sentences from prompt text."""
    from app.subsystems.character.models import SENTENCE_SPLIT_PATTERN
    return [s.strip() for s in SENTENCE_SPLIT_PATTERN.split(text or "") if s.strip()]


def normalize_instruction_text(text: str) -> str:
    """Return text with whitespace collapsed and surrounding punctuation cleaned."""
    cleaned = " ".join(str(text or "").split()).strip()
    if not cleaned:
        return ""
    # Ensure it ends with a period if it looks like a sentence and doesn't have one
    if cleaned and cleaned[-1] not in ".!?":
        cleaned += "."
    return cleaned


def non_empty_layers(layers: dict[str, str]) -> dict[str, str]:
    """Return only layers that contain instruction text."""
    return {k: v.strip() for k, v in layers.items() if v.strip()}


def extend_unique(target: list[str], items: list[str]) -> None:
    """Append items to target list only if they are not already present (case-insensitive)."""
    seen = {t.strip().lower() for t in target}
    for item in items:
        cleaned = item.strip()
        if cleaned and cleaned.lower() not in seen:
            target.append(cleaned)
            seen.add(cleaned.lower())
