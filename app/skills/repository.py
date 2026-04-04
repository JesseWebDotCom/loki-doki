"""Skill repository index and package access."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.catalog import CatalogError, fetch_catalog_json, join_catalog_url, local_path_to_file_url
from app.config import AppConfig


class SkillRepository:
    """Read the remote or local skill repository index used by the in-app skill store."""

    def __init__(self, config: AppConfig):
        self._config = config

    def list_available(self) -> list[dict[str, Any]]:
        """Return all available skills from the configured catalog."""
        dev_items = self._read_dev()
        remote_items = self._read_remote()
        if remote_items:
            return dev_items + remote_items
        return dev_items + self._read_local()

    def get(self, skill_id: str) -> Optional[dict[str, Any]]:
        """Return one repository skill record."""
        for item in self.list_available():
            if str(item.get("id")) == skill_id:
                return item
        return None

    def catalog_info(self) -> dict[str, str]:
        """Return top-level metadata for the active skill catalog."""
        try:
            payload = fetch_catalog_json(self._config.skills_repository_index_url)
            return {
                "title": str(payload.get("title") or "LokiDoki Skills").strip() or "LokiDoki Skills",
                "description": str(payload.get("description") or "").strip(),
                "repo_url": str(payload.get("repo_url") or "").strip(),
                "source_repo_url": str(payload.get("source_repo_url") or "").strip(),
                "index_url": self._config.skills_repository_index_url,
            }
        except CatalogError:
            return {
                "title": "Local Skills",
                "description": "Fallback local skill catalog.",
                "repo_url": "",
                "source_repo_url": "",
                "index_url": self._config.skills_repository_index_url,
            }

    def _read_remote(self) -> list[dict[str, Any]]:
        """Return skills from the configured remote index."""
        try:
            payload = fetch_catalog_json(self._config.skills_repository_index_url)
        except CatalogError:
            return []
        skills = payload.get("skills", [])
        if not isinstance(skills, list):
            return []
        return [self._normalize_remote_entry(item) for item in skills if isinstance(item, dict)]

    def _read_local(self) -> list[dict[str, Any]]:
        """Return fallback skills from the bundled local index."""
        if not self._config.skills_repo_index_path.exists():
            return []
        payload = json.loads(self._config.skills_repo_index_path.read_text(encoding="utf-8"))
        skills = payload.get("skills", [])
        return [self._normalize_local_entry(item) for item in skills if isinstance(item, dict)]

    def _normalize_remote_entry(self, item: dict[str, Any]) -> dict[str, Any]:
        """Return one normalized remote skill entry."""
        base_url = self._config.skills_repository_index_url
        normalized = dict(item)
        normalized["download_url"] = join_catalog_url(base_url, str(item.get("download_url") or "").strip())
        normalized["logo_url"] = join_catalog_url(base_url, str(item.get("logo_url") or "").strip())
        normalized["meta_url"] = join_catalog_url(base_url, str(item.get("meta_url") or "").strip())
        normalized["domains"] = [str(value) for value in list(item.get("domains") or [item.get("domain") or ""]) if str(value).strip()]
        normalized["platforms"] = [str(value) for value in list(item.get("platforms") or []) if str(value).strip()]
        normalized["latest_version"] = str(item.get("latest_version") or item.get("version") or "1.0.0").strip() or "1.0.0"
        normalized["account_mode"] = str(item.get("account_mode") or "none").strip() or "none"
        return normalized

    def _normalize_local_entry(self, item: dict[str, Any]) -> dict[str, Any]:
        """Return one normalized bundled skill entry."""
        normalized = dict(item)
        logo_url = str(item.get("logo_url") or "").strip()
        if logo_url and not logo_url.startswith(("http://", "https://", "data:", "/")):
            normalized["logo_url"] = local_path_to_file_url(Path(logo_url))
        normalized["domains"] = [str(value) for value in list(item.get("domains") or [item.get("domain") or ""]) if str(value).strip()]
        normalized["platforms"] = [str(value) for value in list(item.get("platforms") or []) if str(value).strip()]
        normalized["latest_version"] = str(item.get("latest_version") or item.get("version") or "1.0.0").strip() or "1.0.0"
        normalized["account_mode"] = str(item.get("account_mode") or "none").strip() or "none"
        return normalized

    def _read_dev(self) -> list[dict[str, Any]]:
        """Return skills from the local development source (if configured)."""
        if not self._config.dev_skills_path or not self._config.dev_skills_path.exists():
            return []
        
        from app.skills.manifest import load_manifest, validate_manifest
        items = []
        for manifest_path in sorted(self._config.dev_skills_path.glob("*/manifest.json")):
            try:
                definition = validate_manifest(load_manifest(manifest_path))
                skill_dir = manifest_path.parent
                item = {
                    "id": definition.skill_id,
                    "title": f"(Dev) {definition.title}",
                    "description": definition.description,
                    "version": definition.version,
                    "domain": definition.domain,
                    "domains": [definition.domain],
                    "platforms": ["mac", "pi_cpu", "pi_hailo"],
                    "account_mode": definition.account_mode,
                    "package_dir": str(skill_dir),
                    "logo_url": local_path_to_file_url(skill_dir / definition.raw_manifest["logo_path"]) if definition.raw_manifest.get("logo_path") else "",
                }
                items.append(item)
            except Exception:
                continue
        return items
