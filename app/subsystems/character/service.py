"""Character catalog, policy storage, and prompt orchestration service."""

from __future__ import annotations

import base64
import json
import sqlite3
import subprocess
import urllib.parse
from pathlib import Path
from typing import Any, Optional, Union

from app.config import AppConfig, get_app_config
from app.providers.types import ProviderSpec
from app.subsystems.character.models import (
    CharacterDefinition,
    CharacterRenderingContext,
    PROMPT_LAYER_ORDER,
    ParsedModelResponse,
)
from app.subsystems.character import catalog, policy, care, user_settings, compiler, render, utils


class CharacterService:
    """Manage characters, policies, and prompt-layer compilation."""

    def initialize(self, conn: sqlite3.Connection, config: AppConfig) -> None:
        """Sync character catalog rows from the built-in and repository folders."""
        catalog.initialize_catalog(conn, config)

    def list_characters(self, conn: sqlite3.Connection, config: Optional[AppConfig] = None) -> dict[str, list[dict[str, Any]]]:
        """Return installed and available characters for the UI."""
        resolved_config = config or get_app_config()
        return catalog.list_characters(conn, resolved_config)

    def install_character(self, conn: sqlite3.Connection, config: AppConfig, character_id: str) -> dict[str, Any]:
        """Install or refresh one repository character into the catalog."""
        self.initialize(conn, config)
        character = self._resolve_character(conn, character_id)
        if character is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        return character.to_dict()

    def set_catalog_enabled(self, conn: sqlite3.Connection, character_id: str, enabled: bool) -> dict[str, Any]:
        """Enable or disable one character in the catalog."""
        current = self._resolve_character(conn, character_id)
        if current is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        if current.builtin and not enabled:
            raise ValueError("The built-in LokiDoki character cannot be disabled.")
        conn.execute(
            "UPDATE character_catalog SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE character_id = ?",
            (int(enabled), character_id),
        )
        conn.commit()
        refreshed = self._resolve_character(conn, character_id)
        if refreshed is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        return refreshed.to_dict()

    def update_character_manifest(self, conn: sqlite3.Connection, config: AppConfig, character_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Update editable metadata in one file-backed character manifest."""
        character = self._resolve_character(conn, character_id)
        if character is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        manifest_path = Path(character.path) / "character.json"
        utils.validate_manifest_path(manifest_path, config)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        logo_value = str(values.get("logo", manifest.get("logo") or "") or "").strip()
        manifest["logo"] = self._persist_logo_asset(Path(character.path), logo_value, source_dir=Path(character.path), required=False)
        manifest["id"] = character.character_id
        manifest["name"] = str(values.get("name", manifest.get("name") or character.name)).strip() or character.name
        manifest["description"] = str(values.get("description", manifest.get("description") or character.description)).strip()
        manifest["teaser"] = str(values.get("teaser", manifest.get("teaser") or character.teaser)).strip()
        manifest["phonetic_spelling"] = str(values.get("phonetic_spelling", manifest.get("phonetic_spelling") or character.phonetic_spelling)).strip()
        manifest["system_prompt"] = str(values.get("system_prompt", manifest.get("system_prompt") or character.system_prompt)).strip()
        manifest["identity_key"] = str(values.get("identity_key", manifest.get("identity_key") or character.identity_key or character.character_id)).strip() or character.character_id
        manifest["domain"] = str(values.get("domain", manifest.get("domain") or character.domain)).strip()
        manifest["behavior_style"] = str(values.get("behavior_style", manifest.get("behavior_style") or character.behavior_style or manifest["system_prompt"])).strip()
        manifest["voice_model"] = str(values.get("voice_model", manifest.get("voice_model") or character.voice_model or character.default_voice)).strip()
        manifest["default_voice"] = str(values.get("default_voice", manifest.get("default_voice") or character.default_voice)).strip()
        manifest["default_voice_download_url"] = str(values.get("default_voice_download_url", manifest.get("default_voice_download_url") or character.default_voice_download_url)).strip()
        manifest["default_voice_config_download_url"] = str(values.get("default_voice_config_download_url", manifest.get("default_voice_config_download_url") or character.default_voice_config_download_url)).strip()
        manifest["default_voice_source_name"] = str(values.get("default_voice_source_name", manifest.get("default_voice_source_name") or character.default_voice_source_name)).strip()
        manifest["default_voice_config_source_name"] = str(values.get("default_voice_config_source_name", manifest.get("default_voice_config_source_name") or character.default_voice_config_source_name)).strip()
        manifest["wakeword_model_id"] = str(values.get("wakeword_model_id", manifest.get("wakeword_model_id") or character.wakeword_model_id)).strip()
        wakeword_upload = str(values.get("wakeword_upload_data_url") or "").strip()
        manifest["wakeword_source_name"] = str(values.get("wakeword_source_name", manifest.get("wakeword_source_name") or character.wakeword_source_name)).strip()
        manifest["wakeword_download_url"] = str(values.get("wakeword_download_url", manifest.get("wakeword_download_url") or character.wakeword_download_url)).strip()
        if wakeword_upload:
            manifest["wakeword_download_url"] = self._persist_wakeword_asset(
                Path(character.path),
                manifest["wakeword_source_name"] or f"{manifest['wakeword_model_id'] or character.character_id}.onnx",
                wakeword_upload,
            )
        manifest["character_editor"] = dict(values.get("character_editor") or manifest.get("character_editor") or character.character_editor)
        manifest["capabilities"] = dict(manifest.get("capabilities") or character.capabilities or {})
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        self.initialize(conn, config)
        refreshed = self._resolve_character(conn, character_id)
        if refreshed is None:
            raise ValueError(f"Character {character_id!r} could not be reloaded.")
        return refreshed.to_dict()

    def delete_character(self, conn: sqlite3.Connection, config: AppConfig, character_id: str) -> dict[str, list[dict[str, Any]]]:
        """Delete one repository-backed character and reset dependent settings."""
        return catalog.delete_character(conn, config, character_id)

    def export_character_package(self, conn: sqlite3.Connection, character_id: str) -> dict[str, Any]:
        """Return one portable JSON package for a character."""
        character = self._resolve_character(conn, character_id)
        if character is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        return {"format": "lokidoki-character-package", "character": character.to_dict()}

    def import_character_package(self, conn: sqlite3.Connection, config: AppConfig, package: dict[str, Any]) -> dict[str, Any]:
        """Import one portable character package into the local repository."""
        if str(package.get("format") or "").strip() != "lokidoki-character-package":
            raise ValueError("Unsupported character package format.")
        payload = package.get("character")
        if not isinstance(payload, dict):
            raise ValueError("Character package is missing a character payload.")
        raw_character_id = str(payload.get("id") or "").strip()
        character_id = raw_character_id or utils.normalize_character_id(
            str(payload.get("name") or payload.get("identity_key") or "").strip()
        )
        if not character_id:
            raise ValueError("Character package is missing a valid character id.")
        target_dir = config.characters_repository_dir / character_id
        target_dir.mkdir(parents=True, exist_ok=True)
        manifest = self._manifest_from_payload(character_id, payload, target_dir)
        (target_dir / "character.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        self.initialize(conn, config)
        refreshed = self._resolve_character(conn, character_id)
        if refreshed is None:
            raise ValueError(f"Character {character_id!r} could not be imported.")
        return refreshed.to_dict()

    def publish_character_to_repository(self, conn: sqlite3.Connection, config: AppConfig, character_id: str) -> dict[str, str]:
        """Publish one installed character into the sibling character repository."""
        character = self._resolve_character(conn, character_id)
        if character is None:
            raise ValueError(f"Character {character_id!r} is not installed.")
        manifest_path = Path(character.path) / "character.json"
        if not manifest_path.exists():
            raise ValueError(f"Character {character_id!r} is missing its manifest.")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source_root = self._characters_repo_root()
        source_dir = source_root / "sources" / "characters" / character_id
        source_dir.mkdir(parents=True, exist_ok=True)
        manifest["logo"] = self._persist_logo_asset(
            source_dir,
            str(manifest.get("logo") or character.logo or "").strip(),
            source_dir=Path(character.path),
            required=True,
        )
        (source_dir / "character.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        build_script = source_root / "scripts" / "build_index.py"
        subprocess.run(["python3", str(build_script)], cwd=str(source_root), check=True)
        return {
            "repo_path": str(source_root),
            "source_dir": str(source_dir),
            "manifest_path": str(source_dir / "character.json"),
            "published_package_path": str(source_root / "characters" / character_id / f"{character_id}.zip"),
        }

    def update_account(self, conn: sqlite3.Connection, account_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Persist editable account settings used by the admin UI."""
        current = policy.get_account(conn, account_id)
        next_default_character_id = str(values.get("default_character_id", current["default_character_id"]) or "lokidoki").strip() or "lokidoki"
        if self._resolve_character(conn, next_default_character_id) is None:
            raise ValueError(f"Character {next_default_character_id!r} is not installed.")
        conn.execute(
            """
            UPDATE accounts
            SET name = ?, default_character_id = ?, character_feature_enabled = ?
            WHERE id = ?
            """,
            (
                str(values.get("name", current["name"])).strip() or current["name"],
                next_default_character_id,
                int(bool(values.get("character_feature_enabled", current["character_feature_enabled"]))),
                account_id,
            ),
        )
        conn.commit()
        return policy.get_account(conn, account_id)

    def get_account(self, conn: sqlite3.Connection, account_id: str) -> dict[str, Any]:
        """Return one account with its prompt policy."""
        return policy.get_account(conn, account_id)

    def get_prompt_policy(self, conn: sqlite3.Connection, account_id: str) -> dict[str, Any]:
        """Return the account-level prompt policy."""
        return policy.get_prompt_policy(conn, account_id)

    def update_prompt_policy(self, conn: sqlite3.Connection, account_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Persist the account-level prompt policy."""
        return policy.update_prompt_policy(conn, account_id, values)

    def list_care_profiles(self, conn: sqlite3.Connection) -> list[dict[str, Any]]:
        """Return care profiles for admin and user settings views."""
        return care.list_care_profiles(conn)

    def upsert_care_profile(self, conn: sqlite3.Connection, values: dict[str, Any]) -> dict[str, Any]:
        """Create or update one care profile."""
        return care.upsert_care_profile(conn, values)

    def get_user_settings(self, conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
        """Return user character settings plus care profile and prompt overrides."""
        return user_settings.get_user_settings(conn, user_id)

    def update_user_settings(self, conn: sqlite3.Connection, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Persist user-controlled character settings."""
        return user_settings.update_user_settings(conn, user_id, values)

    def update_user_overrides(self, conn: sqlite3.Connection, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Persist admin-controlled prompt overrides for one user."""
        return user_settings.update_user_overrides(conn, user_id, values)

    def build_rendering_context(
        self,
        conn: sqlite3.Connection,
        current_user: dict[str, Any],
        profile: str,
        enabled_layers: Optional[dict[str, bool]] = None,
        layer_overrides: Optional[dict[str, str]] = None,
        compiler_provider: Optional[ProviderSpec] = None,
        persist_compiled: bool = True,
        force_recompile: bool = False,
    ) -> CharacterRenderingContext:
        """Resolve all prompt layers and cache the compiled base prompt."""
        state = self.resolve_prompt_state(conn, current_user, enabled_layers, layer_overrides)
        non_empty = state["non_empty_layers"]
        compiled_hash = compiler.get_prompt_hash(non_empty)
        base_prompt = compiler.compile_base_prompt(non_empty, compiler_provider)
        
        if persist_compiled:
             conn.execute(
                 "UPDATE user_character_settings SET base_prompt_hash = ?, compiled_prompt_hash = ?, compiled_base_prompt = ? WHERE user_id = ?",
                 (compiled_hash, compiled_hash, base_prompt, current_user["id"])
             )
             conn.commit()
             
        return CharacterRenderingContext(
            user_id=str(current_user["id"]),
            account_id=str(current_user.get("account_id") or "default-account"),
            display_name=str(current_user["display_name"]),
            profile=profile,
            base_prompt=base_prompt,
            base_prompt_hash=compiled_hash,
            active_character_id=state["active_character_id"],
            active_character_name=state["active_character_name"],
            character_behavior_style=str(state.get("active_character_behavior_style") or ""),
            care_profile_id=str(state["care_profile"]["id"]),
            care_profile_sentence_length=str(state["care_profile"]["sentence_length"]),
            care_profile_response_style=str(state["care_profile"].get("response_style") or "chat_balanced"),
            character_enabled=state["character_enabled"],
            proactive_chatter_enabled=bool(state["account"].get("proactive_chatter_enabled", False)),
            blocked_topics=state["blocked_topics"],
            max_response_tokens=int(state["care_profile"]["max_response_tokens"]),
            debug={"prompt_hash": compiled_hash, "character_id": state["active_character_id"]},
        )

    def resolve_prompt_state(
        self,
        conn: sqlite3.Connection,
        current_user: dict[str, Any],
        enabled_layers: Optional[dict[str, bool]] = None,
        layer_overrides: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        """Resolve prompt layers and related metadata without compiling or persisting."""
        settings = self.get_user_settings(conn, current_user["id"])
        account = self.get_account(conn, str(current_user.get("account_id") or "default-account"))
        care_prof = care.get_care_profile_by_id(conn, settings["care_profile_id"])
        
        selected_character_id = settings["active_character_id"] or account["default_character_id"]
        char = self._resolve_character(conn, selected_character_id)
        if char is None and selected_character_id != "lokidoki":
            char = self._resolve_character(conn, "lokidoki")
            selected_character_id = "lokidoki" if char else selected_character_id
        
        blocked = tuple(dict.fromkeys([*care_prof["blocked_topics"], *settings["blocked_topics"]]))
        layers = {
            "core_safety_prompt": account["core_safety_prompt"] or "You are LokiDoki.",
            "account_policy_prompt": account["account_policy_prompt"],
            "admin_prompt": settings["admin_prompt"],
            "care_profile_prompt": f"Tone: {care_prof['tone']}",
            "user_prompt": settings["user_prompt"],
            "character_prompt": char.system_prompt if char else "",
        }
        return {
            "prompt_layers": layers,
            "non_empty_layers": utils.non_empty_layers(layers),
            "user_settings": settings,
            "account": account,
            "care_profile": care_prof,
            "active_character_id": selected_character_id if char else None,
            "active_character_name": char.name if char else "",
            "active_character_behavior_style": char.behavior_style if char else "",
            "character_enabled": bool(char),
            "blocked_topics": blocked,
            "enabled_layers": enabled_layers or {},
        }

    def prompt_compiler_messages(self, non_empty_layers: dict[str, str]) -> list[dict[str, str]]:
        """Return the exact compiler messages used for one prompt compile."""
        return compiler.get_prompt_compiler_messages(non_empty_layers)

    def build_messages(
        self,
        context: CharacterRenderingContext,
        classification: str,
        message: str,
        history: list[dict[str, str]],
        dynamic_context: str = "",
        response_style: str = "chat_balanced",
    ) -> list[dict[str, str]]:
        """Build the final chat message list for the model."""
        return render.build_messages(context, classification, message, history, dynamic_context, response_style)

    def parse_model_response(self, raw_text: str) -> Optional[ParsedModelResponse]:
        """Parse one JSON-first model response."""
        return render.parse_model_response(raw_text)

    def blocked_topic_reply(self, context: CharacterRenderingContext, message: str) -> Optional[str]:
        """Return a deterministic blocked-topic reply when the request obviously hits a blocked topic."""
        return render.blocked_topic_reply(context, message)

    def _resolve_character(self, conn: sqlite3.Connection, character_id: Optional[str]) -> Optional[CharacterDefinition]:
        """Return one loaded character definition from the catalog."""
        if not character_id:
            return None
        row = conn.execute(
            "SELECT * FROM character_catalog WHERE character_id = ?",
            (character_id,),
        ).fetchone()
        return utils.row_to_definition(row) if row else None

    def _manifest_from_payload(self, character_id: str, payload: dict[str, Any], target_dir: Path) -> dict[str, Any]:
        """Normalize one imported package payload into a manifest."""
        system_prompt = str(payload.get("system_prompt") or payload.get("behavior_style") or "").strip()
        if not system_prompt:
            raise ValueError("Character package is missing a system prompt.")
        manifest = {
            "id": character_id,
            "name": str(payload.get("name") or character_id).strip() or character_id,
            "version": str(payload.get("version") or "1.0.0").strip() or "1.0.0",
            "source": str(payload.get("source") or "repository").strip() or "repository",
            "phonetic_spelling": str(payload.get("phonetic_spelling") or "").strip(),
            "identity_key": str(payload.get("identity_key") or character_id).strip() or character_id,
            "domain": str(payload.get("domain") or "avataaars").strip() or "avataaars",
            "description": str(payload.get("description") or "").strip(),
            "teaser": str(payload.get("teaser") or "").strip(),
            "behavior_style": str(payload.get("behavior_style") or system_prompt).strip(),
            "voice_model": str(payload.get("voice_model") or payload.get("default_voice") or "").strip(),
            "default_voice": str(payload.get("default_voice") or payload.get("voice_model") or "").strip(),
            "default_voice_download_url": str(payload.get("default_voice_download_url") or "").strip(),
            "default_voice_config_download_url": str(payload.get("default_voice_config_download_url") or "").strip(),
            "default_voice_source_name": str(payload.get("default_voice_source_name") or "").strip(),
            "default_voice_config_source_name": str(payload.get("default_voice_config_source_name") or "").strip(),
            "wakeword_model_id": str(payload.get("wakeword_model_id") or "").strip(),
            "wakeword_download_url": str(payload.get("wakeword_download_url") or "").strip(),
            "wakeword_source_name": str(payload.get("wakeword_source_name") or "").strip(),
            "system_prompt": system_prompt,
            "character_editor": dict(payload.get("character_editor") or {}),
            "capabilities": dict(payload.get("capabilities") or {}),
            "enabled": bool(payload.get("enabled", True)),
        }
        manifest["logo"] = self._persist_logo_asset(target_dir, str(payload.get("logo") or "").strip(), required=True)
        wakeword_upload = str(payload.get("wakeword_upload_data_url") or "").strip()
        if wakeword_upload:
            manifest["wakeword_download_url"] = self._persist_wakeword_asset(
                target_dir,
                manifest["wakeword_source_name"] or f"{manifest['wakeword_model_id'] or character_id}.onnx",
                wakeword_upload,
            )
        return manifest

    def _persist_logo_asset(
        self,
        target_dir: Path,
        logo_value: str,
        *,
        source_dir: Path | None = None,
        required: bool,
    ) -> str:
        """Persist one generated logo into a character directory and return the manifest logo filename."""
        cleaned = str(logo_value or "").strip()
        if not cleaned:
            if required:
                raise ValueError("A generated logo is required before publishing this character.")
            return ""
        if cleaned.startswith("data:image/"):
            header, _, encoded = cleaned.partition(",")
            mime_type = header.split(";", 1)[0].split(":", 1)[1]
            extension = {
                "image/svg+xml": ".svg",
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/webp": ".webp",
            }.get(mime_type)
            if not extension:
                raise ValueError("Unsupported generated logo format.")
            payload = (
                base64.b64decode(encoded)
                if ";base64" in header
                else urllib.parse.unquote_to_bytes(encoded)
            )
            filename = f"logo{extension}"
            (target_dir / filename).write_bytes(payload)
            return filename
        if cleaned.startswith(("http://", "https://")):
            raise ValueError("Published characters must use a generated local logo asset, not a remote URL.")
        source_path = Path(cleaned)
        if not source_path.is_absolute():
            source_path = (source_dir or target_dir) / source_path
        if not source_path.exists():
            if required:
                raise ValueError("The generated logo asset could not be found.")
            return ""
        filename = f"logo{source_path.suffix.lower() or '.svg'}"
        if source_path.resolve() != (target_dir / filename).resolve():
            (target_dir / filename).write_bytes(source_path.read_bytes())
        return filename

    def _persist_wakeword_asset(self, target_dir: Path, source_name: str, data_url: str) -> str:
        """Persist one uploaded wakeword model into a character directory."""
        payload = str(data_url or "").strip()
        if not payload or "," not in payload:
            raise ValueError("The uploaded wakeword model is invalid.")
        header, _, encoded = payload.partition(",")
        if not header.startswith("data:"):
            raise ValueError("The uploaded wakeword model must be a data URL.")
        try:
            model_bytes = (
                base64.b64decode(encoded)
                if ";base64" in header
                else urllib.parse.unquote_to_bytes(encoded)
            )
        except Exception as exc:
            raise ValueError("The uploaded wakeword model could not be decoded.") from exc
        filename = f"wakeword{Path(source_name or 'wakeword.onnx').suffix or '.onnx'}"
        (target_dir / filename).write_bytes(model_bytes)
        return filename

    def _characters_repo_root(self) -> Path:
        """Return the sibling loki-doki-characters repository path."""
        return Path(__file__).resolve().parents[4] / "loki-doki-characters"


character_service = CharacterService()
