"""Character catalog management logic."""

from __future__ import annotations

import json
import sqlite3
import shutil
from pathlib import Path
from typing import Any

from app.config import AppConfig
from app.subsystems.character import utils
from app.subsystems.character.models import CharacterDefinition
from app.subsystems.character.repository import CharacterRepository


def load_definitions(directory: Path, source: str, *, builtin: bool = False) -> list[CharacterDefinition]:
    """Load all valid character definitions from one local folder."""
    if not directory.exists():
        return []
    definitions: list[CharacterDefinition] = []
    for item in directory.iterdir():
        manifest_path = item / "character.json"
        if not item.is_dir() or not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            definitions.append(
                CharacterDefinition(
                    character_id=str(manifest.get("id") or item.name).strip(),
                    name=str(manifest.get("name") or item.name).strip(),
                    version=str(manifest.get("version") or "1.0.0").strip(),
                    source=source,
                    system_prompt=str(manifest.get("system_prompt") or "").strip(),
                    default_voice=str(manifest.get("default_voice") or "").strip(),
                    default_voice_download_url=str(manifest.get("default_voice_download_url") or "").strip(),
                    default_voice_config_download_url=str(manifest.get("default_voice_config_download_url") or "").strip(),
                    default_voice_source_name=str(manifest.get("default_voice_source_name") or "").strip(),
                    default_voice_config_source_name=str(manifest.get("default_voice_config_source_name") or "").strip(),
                    wakeword_model_id=str(manifest.get("wakeword_model_id") or "").strip(),
                    wakeword_download_url=str(manifest.get("wakeword_download_url") or "").strip(),
                    wakeword_source_name=str(manifest.get("wakeword_source_name") or "").strip(),
                    capabilities=dict(manifest.get("capabilities") or {}),
                    logo=str(manifest.get("logo") or "").strip(),
                    description=str(manifest.get("description") or "").strip(),
                    path=str(item.resolve()),
                    teaser=str(manifest.get("teaser") or "").strip(),
                    phonetic_spelling=str(manifest.get("phonetic_spelling") or "").strip(),
                    identity_key=str(manifest.get("identity_key") or "").strip(),
                    domain=str(manifest.get("domain") or "").strip(),
                    behavior_style=str(manifest.get("behavior_style") or "").strip(),
                    voice_model=str(manifest.get("voice_model") or "").strip(),
                    character_editor=dict(manifest.get("character_editor") or {}),
                    enabled=True,
                    builtin=builtin,
                )
            )
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            continue
    return definitions


def initialize_catalog(conn: sqlite3.Connection, config: AppConfig) -> None:
    """Sync character catalog rows from the built-in and repository folders."""
    definitions = [
        *load_definitions(config.characters_builtin_dir, "builtin", builtin=True),
        *load_definitions(config.characters_repository_dir, "repository", builtin=False),
    ]
    if not definitions:
        return
    for definition in definitions:
        conn.execute(
            """
            INSERT INTO character_catalog (
                character_id, name, version, source, system_prompt, teaser, phonetic_spelling, identity_key, domain,
                behavior_style, voice_model, default_voice, default_voice_download_url,
                default_voice_config_download_url, default_voice_source_name,
                default_voice_config_source_name, wakeword_model_id, wakeword_download_url,
                wakeword_source_name, capabilities_json, character_editor_json, logo,
                enabled, builtin, path, description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(character_id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                source = excluded.source,
                system_prompt = excluded.system_prompt,
                teaser = excluded.teaser,
                phonetic_spelling = excluded.phonetic_spelling,
                identity_key = excluded.identity_key,
                domain = excluded.domain,
                behavior_style = excluded.behavior_style,
                voice_model = excluded.voice_model,
                default_voice = excluded.default_voice,
                default_voice_download_url = excluded.default_voice_download_url,
                default_voice_config_download_url = excluded.default_voice_config_download_url,
                default_voice_source_name = excluded.default_voice_source_name,
                default_voice_config_source_name = excluded.default_voice_config_source_name,
                wakeword_model_id = excluded.wakeword_model_id,
                wakeword_download_url = excluded.wakeword_download_url,
                wakeword_source_name = excluded.wakeword_source_name,
                capabilities_json = excluded.capabilities_json,
                character_editor_json = excluded.character_editor_json,
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
                definition.teaser,
                definition.phonetic_spelling,
                definition.identity_key,
                definition.domain,
                definition.behavior_style,
                definition.voice_model,
                definition.default_voice,
                definition.default_voice_download_url,
                definition.default_voice_config_download_url,
                definition.default_voice_source_name,
                definition.default_voice_config_source_name,
                definition.wakeword_model_id,
                definition.wakeword_download_url,
                definition.wakeword_source_name,
                json.dumps(definition.capabilities),
                json.dumps(definition.character_editor),
                definition.logo,
                int(definition.enabled),
                int(definition.builtin),
                definition.path,
                definition.description,
            ),
        )
    _reconcile_removed_characters(conn, config, {definition.character_id for definition in definitions})
    conn.commit()


def list_characters(conn: sqlite3.Connection, config: AppConfig) -> dict[str, list[dict[str, Any]]]:
    """Return installed and available characters for the UI."""
    rows = conn.execute(
        """
        SELECT character_id, name, version, source, system_prompt, teaser, phonetic_spelling, identity_key, domain,
               behavior_style, voice_model, default_voice, default_voice_download_url,
               default_voice_config_download_url, default_voice_source_name,
               default_voice_config_source_name, wakeword_model_id, wakeword_download_url,
               wakeword_source_name, capabilities_json, character_editor_json, logo,
               enabled, builtin, path, description
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
    _reconcile_removed_characters(conn, config, _current_character_ids(conn) - {character_id}, removed_ids={character_id})
    if character_path.exists():
        shutil.rmtree(character_path)
    initialize_catalog(conn, config)
    return list_characters(conn, config)


def _current_character_ids(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT character_id FROM character_catalog").fetchall()
    return {str(row["character_id"]) for row in rows}


def _reconcile_removed_characters(
    conn: sqlite3.Connection,
    config: AppConfig,
    expected_ids: set[str],
    *,
    removed_ids: str | set[str] | None = None,
) -> None:
    rows = conn.execute(
        "SELECT character_id, path FROM character_catalog WHERE source IN ('builtin', 'repository')"
    ).fetchall()
    stale_ids = {str(row["character_id"]) for row in rows if str(row["character_id"]) not in expected_ids}
    if isinstance(removed_ids, str):
        stale_ids.add(removed_ids)
    elif isinstance(removed_ids, set):
        stale_ids.update(removed_ids)
    if not stale_ids:
        return
    _cleanup_removed_character_data(conn, stale_ids)
    conn.executemany(
        "DELETE FROM character_catalog WHERE character_id = ?",
        [(character_id,) for character_id in sorted(stale_ids)],
    )


def _cleanup_removed_character_data(conn: sqlite3.Connection, character_ids: set[str]) -> None:
    placeholders = ",".join("?" for _ in character_ids)
    params = tuple(sorted(character_ids))
    conn.execute(
        f"UPDATE accounts SET default_character_id = 'lokidoki' WHERE default_character_id IN ({placeholders})",
        params,
    )
    conn.execute(
        f"UPDATE user_character_settings SET active_character_id = 'lokidoki' WHERE active_character_id IN ({placeholders})",
        params,
    )
    conn.execute(
        f"UPDATE user_character_settings SET assigned_character_id = 'lokidoki' WHERE assigned_character_id IN ({placeholders})",
        params,
    )
    conn.execute(
        f"DELETE FROM user_character_customizations WHERE character_id IN ({placeholders})",
        params,
    )
    _queue_person_memory_deletes(conn, params)
    _queue_row_deletes(conn, "mem_char_world_knowledge", "character_id", params, "character_world")
    _queue_row_deletes(conn, "mem_char_evolution_state", "character_id", params, "character_evolution")
    _queue_row_deletes(conn, "mem_char_cross_awareness", "char_a", params, "character_cross_awareness")
    _queue_row_deletes(conn, "mem_char_cross_awareness", "char_b", params, "character_cross_awareness")
    _queue_row_deletes(conn, "mem_characters", "id", params, "character_registry")
    conn.execute(f"DELETE FROM mem_char_user_memory WHERE character_id IN ({placeholders})", params)
    conn.execute(f"DELETE FROM mem_char_world_knowledge WHERE character_id IN ({placeholders})", params)
    conn.execute(f"DELETE FROM mem_char_evolution_state WHERE character_id IN ({placeholders})", params)
    conn.execute(f"DELETE FROM mem_char_cross_awareness WHERE char_a IN ({placeholders}) OR char_b IN ({placeholders})", params + params)
    conn.execute(f"DELETE FROM mem_characters WHERE id IN ({placeholders})", params)


def _queue_person_memory_deletes(conn: sqlite3.Connection, character_ids: tuple[str, ...]) -> None:
    placeholders = ",".join("?" for _ in character_ids)
    rows = conn.execute(
        f"""
        SELECT user_id, character_id, key
        FROM mem_char_user_memory
        WHERE character_id IN ({placeholders})
        """,
        character_ids,
    ).fetchall()
    for row in rows:
        _enqueue_delete(
            conn,
            "mem_char_user_memory",
            {
                "scope": "person",
                "user_id": str(row["user_id"]),
                "character_id": str(row["character_id"]),
                "key": str(row["key"]),
            },
        )


def _queue_row_deletes(
    conn: sqlite3.Connection,
    table_name: str,
    column_name: str,
    character_ids: tuple[str, ...],
    scope: str,
) -> None:
    placeholders = ",".join("?" for _ in character_ids)
    rows = conn.execute(
        f"SELECT * FROM {table_name} WHERE {column_name} IN ({placeholders})",
        character_ids,
    ).fetchall()
    for row in rows:
        payload = {"scope": scope}
        payload.update({key: row[key] for key in row.keys() if key in {"character_id", "user_id", "fact", "id", "char_a", "char_b"}})
        _enqueue_delete(conn, table_name, payload)


def _enqueue_delete(conn: sqlite3.Connection, table_name: str, payload: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO memory_sync_queue (table_name, operation, payload_json, timestamp)
        VALUES (?, 'delete', ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
        """,
        (table_name, json.dumps(payload, sort_keys=True)),
    )
