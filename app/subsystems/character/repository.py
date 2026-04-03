"""Character repository catalog access."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.catalog import CatalogError, fetch_catalog_json, join_catalog_url
from app.config import AppConfig
from app.subsystems.character.utils import resolve_character_logo_url


@dataclass(frozen=True)
class CharacterRepositoryEntry:
    """One available character from a repository catalog."""

    character_id: str
    name: str
    version: str
    description: str
    source: str
    download_url: str
    logo_url: str
    teaser: str = ""
    meta_url: str = ""
    default_voice: str = ""
    wakeword_model_id: str = ""
    phonetic_spelling: str = ""
    identity_key: str = ""
    domain: str = ""
    behavior_style: str = ""
    voice_model: str = ""
    character_editor: dict[str, Any] | None = None

    def to_catalog_item(self, *, enabled: bool) -> dict[str, Any]:
        """Return a UI-friendly character catalog payload."""
        return {
            "id": self.character_id,
            "name": self.name,
            "version": self.version,
            "source": self.source,
            "system_prompt": "",
            "default_voice": self.default_voice,
            "default_voice_download_url": "",
            "default_voice_config_download_url": "",
            "default_voice_source_name": "",
            "default_voice_config_source_name": "",
            "wakeword_model_id": self.wakeword_model_id,
            "wakeword_download_url": "",
            "wakeword_source_name": "",
            "phonetic_spelling": self.phonetic_spelling,
            "identity_key": self.identity_key or self.character_id,
            "domain": self.domain,
            "behavior_style": self.behavior_style,
            "voice_model": self.voice_model,
            "character_editor": dict(self.character_editor or {}),
            "download_url": self.download_url,
            "meta_url": self.meta_url,
            "logo": self.logo_url,
            "description": self.description,
            "teaser": self.teaser,
            "installed": False,
            "enabled": enabled,
            "builtin": False,
        }


@dataclass(frozen=True)
class CharacterRepositoryCatalog:
    """Top-level character repository metadata."""

    title: str
    description: str
    repo_url: str
    source_repo_url: str
    index_url: str

    def to_dict(self) -> dict[str, str]:
        """Return a JSON-safe payload."""
        return {
            "title": self.title,
            "description": self.description,
            "repo_url": self.repo_url,
            "source_repo_url": self.source_repo_url,
            "index_url": self.index_url,
        }


class CharacterRepository:
    """Read remote and local character catalogs."""

    def __init__(self, config: AppConfig):
        self._config = config

    def list_available(self) -> list[CharacterRepositoryEntry]:
        """Return all available characters, preferring the remote catalog."""
        try:
            remote_entries = self._read_remote()
        except CatalogError:
            remote_entries = []
        return remote_entries if remote_entries else self._read_local()

    def get(self, character_id: str) -> CharacterRepositoryEntry | None:
        """Return one character entry by id."""
        for item in self.list_available():
            if item.character_id == character_id:
                return item
        return None

    def catalog_info(self) -> CharacterRepositoryCatalog:
        """Return repository-level metadata for the active character catalog."""
        try:
            payload = fetch_catalog_json(self._config.characters_repository_index_url)
            return CharacterRepositoryCatalog(
                title=str(payload.get("title") or "LokiDoki Characters").strip() or "LokiDoki Characters",
                description=str(payload.get("description") or "").strip(),
                repo_url=str(payload.get("repo_url") or "").strip(),
                source_repo_url=str(payload.get("source_repo_url") or "").strip(),
                index_url=self._config.characters_repository_index_url,
            )
        except CatalogError:
            return CharacterRepositoryCatalog(
                title="Local Characters",
                description="Fallback local character catalog.",
                repo_url="",
                source_repo_url="",
                index_url=self._config.characters_repository_index_url,
            )

    def _read_remote(self) -> list[CharacterRepositoryEntry]:
        """Return characters from the configured remote index."""
        payload = fetch_catalog_json(self._config.characters_repository_index_url)
        items = payload.get("characters", [])
        if not isinstance(items, list):
            return []
        return [self._entry_from_remote(item) for item in items if isinstance(item, dict)]

    def _read_local(self) -> list[CharacterRepositoryEntry]:
        """Return fallback characters from the local repository directory."""
        entries: list[CharacterRepositoryEntry] = []
        for manifest_path in sorted(self._config.characters_repository_dir.glob("*/character.json")):
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            self._validate_character_editor_manifest_fields(payload, manifest_path)
            logo_value = str(payload.get("logo") or "").strip()
            character_id = str(payload.get("id") or manifest_path.parent.name).strip()
            if logo_value:
                logo_value = resolve_character_logo_url(
                    character_id,
                    str(manifest_path.parent.resolve()),
                    logo_value,
                )
            entries.append(
                CharacterRepositoryEntry(
                    character_id=character_id,
                    name=str(payload.get("name") or payload.get("id") or manifest_path.parent.name).strip(),
                    version=str(payload.get("version") or "1.0.0").strip() or "1.0.0",
                    description=str(payload.get("description") or "").strip(),
                    teaser=str(payload.get("teaser") or "").strip(),
                    source="repository",
                    download_url="",
                    logo_url=logo_value,
                    meta_url="",
                    default_voice=str(payload.get("default_voice") or "").strip(),
                    wakeword_model_id=str(payload.get("wakeword_model_id") or "").strip(),
                    phonetic_spelling=str(payload.get("phonetic_spelling") or "").strip(),
                    identity_key=str(payload.get("identity_key") or payload.get("id") or manifest_path.parent.name).strip(),
                    domain=str(payload.get("domain") or "").strip(),
                    behavior_style=str(payload.get("behavior_style") or "").strip(),
                    voice_model=str(payload.get("voice_model") or "").strip(),
                    character_editor=dict(payload.get("character_editor") or {}),
                )
            )
        return entries

    def _entry_from_remote(self, payload: dict[str, Any]) -> CharacterRepositoryEntry:
        """Normalize one remote character record."""
        base_url = self._config.characters_repository_index_url
        return CharacterRepositoryEntry(
            character_id=str(payload.get("id") or "").strip(),
            name=str(payload.get("display_name") or payload.get("name") or payload.get("id") or "").strip(),
            version=str(payload.get("version") or "1.0.0").strip() or "1.0.0",
            description=str(payload.get("description") or "").strip(),
            teaser=str(payload.get("teaser") or "").strip(),
            source=str(payload.get("source") or "repository").strip() or "repository",
            download_url=join_catalog_url(base_url, str(payload.get("download_url") or "").strip()),
            logo_url=join_catalog_url(base_url, str(payload.get("logo_url") or "").strip()),
            meta_url=join_catalog_url(base_url, str(payload.get("meta_url") or "").strip()),
            default_voice=str(payload.get("default_voice") or "").strip(),
            wakeword_model_id=str(payload.get("wakeword_model_id") or "").strip(),
            phonetic_spelling=str(payload.get("phonetic_spelling") or "").strip(),
            identity_key=str(payload.get("identity_key") or payload.get("id") or "").strip(),
            domain=str(payload.get("domain") or "").strip(),
            behavior_style=str(payload.get("behavior_style") or "").strip(),
            voice_model=str(payload.get("voice_model") or "").strip(),
            character_editor=dict(payload.get("character_editor") or {}),
        )

    def _validate_character_editor_manifest_fields(self, payload: dict[str, Any], manifest_path: Path) -> None:
        """Require the character-editor schema for local repository entries."""
        missing = [
            field
            for field, value in (
                ("identity_key", str(payload.get("identity_key") or "").strip()),
                ("domain", str(payload.get("domain") or "").strip()),
                ("behavior_style", str(payload.get("behavior_style") or "").strip()),
                ("voice_model", str(payload.get("voice_model") or "").strip()),
            )
            if not value
        ]
        character_editor = payload.get("character_editor")
        if missing:
            raise ValueError(
                f"Character manifest {manifest_path} is missing character-editor fields: {', '.join(missing)}"
            )
        if not isinstance(character_editor, dict) or not str(character_editor.get("renderer") or "").strip():
            raise ValueError(f"Character manifest {manifest_path} is missing character_editor.renderer metadata.")
