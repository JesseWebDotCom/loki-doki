"""Character catalog management logic."""

from __future__ import annotations

import json
import sqlite3
import shutil
from pathlib import Path
from typing import Any

from app.catalog import download_catalog_bytes
from app.config import AppConfig
from app.subsystems.character.models import CharacterDefinition
from app.subsystems.character.repository import CharacterRepository
from app.subsystems.character import utils


def load_definitions(directory: Path, source: str, *, builtin: bool = False) -> list[CharacterDefinition]:
    """Load all valid character definitions from one local folder."""
    if not directory.exists():
        return []
    definitions = []
    for item in directory.iterdir():
        if item.is_dir() and (item / "character.json").exists():
            try:
                manifest = json.loads((item / "character.json").read_text(encoding="utf-8"))
                definitions.append(utils.row_to_definition({
                    "character_id": str(manifest.get("id") or item.name).strip(),
                    "name": str(manifest.get("name") or item.name).strip(),
                    "version": str(manifest.get("version") or "1.0.0").strip(),
                    "source": source,
                    "system_prompt": str(manifest.get("system_prompt") or "").strip(),
                    "default_voice": str(manifest.get("default_voice") or "").strip(),
                    "default_voice_download_url": str(manifest.get("default_voice_download_url") or "").strip(),
                    "default_voice_config_download_url": str(manifest.get("default_voice_config_download_url") or "").strip(),
                    "default_voice_source_name": str(manifest.get("default_voice_source_name") or "").strip(),
                    "default_voice_config_source_name": str(manifest.get("default_voice_config_source_name") or "").strip(),
                    "wakeword_model_id": str(manifest.get("wakeword_model_id") or "").strip(),
                    "wakeword_download_url": str(manifest.get("wakeword_download_url") or "").strip(),
                    "wakeword_source_name": str(manifest.get("wakeword_source_name") or "").strip(),
                    "capabilities_json": json.dumps(dict(manifest.get("capabilities") or {})),
                    "logo": str(manifest.get("logo") or "").strip(),
                    "enabled": 1,
                    "builtin": int(builtin),
                    "path": str(item.resolve()),
                    "description": str(manifest.get("description") or "").strip(),
                }))
            except (json.JSONDecodeError, Exception):
                continue
    return definitions


def initialize_catalog(conn: sqlite3.Connection, config: AppConfig) -> None:
    """Sync character catalog rows from the built-in and repository folders."""
    definitions = [
        *load_definitions(config.characters_builtin_dir, "builtin", builtin=True),
        *load_definitions(config.characters_repository_dir, "repository", builtin=False),
    ]
    for definition in definitions:
        conn.execute(
            """
            INSERT INTO character_catalog (
                character_id, name, version, source, system_prompt, default_voice,
                default_voice_download_url, default_voice_config_download_url,
                default_voice_source_name, default_voice_config_source_name,
                wakeword_model_id, wakeword_download_url, wakeword_source_name,
                capabilities_json, logo, enabled, builtin, path, description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(character_id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                source = excluded.source,
                system_prompt = excluded.system_prompt,
                default_voice = excluded.default_voice,
                default_voice_download_url = excluded.default_voice_download_url,
                default_voice_config_download_url = excluded.default_voice_config_download_url,
                default_voice_source_name = excluded.default_voice_source_name,
                default_voice_config_source_name = excluded.default_voice_config_source_name,
                wakeword_model_id = excluded.wakeword_model_id,
                wakeword_download_url = excluded.wakeword_download_url,
                wakeword_source_name = excluded.wakeword_source_name,
                capabilities_json = excluded.capabilities_json,
                logo = excluded.logo,
                builtin = excluded.builtin,
                path = excluded.path,
                description = excluded.description,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                definition.character_id,
                definition.name,
                definition.version,
                definition.source,
                definition.system_prompt,
                definition.default_voice,
                definition.default_voice_download_url,
                definition.default_voice_config_download_url,
                definition.default_voice_source_name,
                definition.default_voice_config_source_name,
                definition.wakeword_model_id,
                definition.wakeword_download_url,
                definition.wakeword_source_name,
                json.dumps(definition.capabilities),
                definition.logo,
                int(definition.enabled),
                int(definition.builtin),
                definition.path,
                definition.description,
            ),
        )
    conn.commit()


def list_characters(conn: sqlite3.Connection, config: AppConfig) -> dict[str, list[dict[str, Any]]]:
    """Return installed and available characters for the UI."""
    rows = conn.execute(
        """
        SELECT character_id, name, version, source, system_prompt, default_voice,
               default_voice_download_url, default_voice_config_download_url,
               default_voice_source_name, default_voice_config_source_name,
               wakeword_model_id, wakeword_download_url, wakeword_source_name,
               capabilities_json, logo, enabled, builtin, path, description
        FROM character_catalog
        ORDER BY builtin DESC, name COLLATE NOCASE ASC
        """
    ).fetchall()
    installed = [utils.row_to_definition(row).to_dict() for row in rows]
    installed_ids = {str(item["id"]) for item in installed}
    available = list(installed)
    repo = CharacterRepository(config)
    for item in repo.list_available():
        if item.character_id in installed_ids:
            continue
        available.append(item.to_catalog_item(enabled=False))
    return {
        "installed": installed,
        "available": available,
        "repository": repo.catalog_info().to_dict(),
    }


def delete_character(conn: sqlite3.Connection, config: AppConfig, character_id: str) -> dict[str, list[dict[str, Any]]]:
    """Delete one repository-backed character and reset dependent settings."""
    row = conn.execute(
        "SELECT character_id, builtin, path FROM character_catalog WHERE character_id = ?",
        (character_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Character {character_id!r} is not installed.")
    if bool(row["builtin"]):
        raise ValueError("The built-in LokiDoki character cannot be deleted.")
    
    character_path = Path(str(row["path"] or ""))
    utils.validate_manifest_path(character_path / "character.json", config)
    
    if character_path.parent.resolve() != config.characters_repository_dir.resolve():
        raise ValueError("Only repository-backed characters can be deleted.")
        
    # Clear settings
    conn.execute("UPDATE accounts SET default_character_id = 'lokidoki' WHERE default_character_id = ?", (character_id,))
    conn.execute("UPDATE user_character_settings SET active_character_id = 'lokidoki' WHERE active_character_id = ?", (character_id,))
    conn.execute("DELETE FROM user_character_customizations WHERE character_id = ?", (character_id,))
    conn.execute("DELETE FROM character_catalog WHERE character_id = ?", (character_id,))
    conn.commit()
    
    if character_path.exists():
        shutil.rmtree(character_path)
        
    initialize_catalog(conn, config)
    return list_characters(conn, config)
