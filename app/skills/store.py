"""Skill store and repository management."""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from app.config import AppConfig
from app.skills.installer import SkillInstaller
from app.skills.registry import SkillRegistry
from app.skills.repository import SkillRepository


class SkillStore:
    """Handle skill repository browsing and syncing."""

    def __init__(self, registry: SkillRegistry, installer: SkillInstaller) -> None:
        self._registry = registry
        self._installer = installer

    def list_available(self, conn: sqlite3.Connection, config: AppConfig) -> list[dict[str, Any]]:
        """Return skill repository entries plus install state."""
        repo = SkillRepository(config)
        installed_ids = {record.skill_id for record in self._registry.list_installed(conn)}
        items: list[dict[str, Any]] = []
        for item in repo.list_available():
            items.append({**item, "installed": str(item.get("id")) in installed_ids})
        return items

    def catalog_info(self, config: AppConfig) -> dict[str, str]:
        """Return repository-level metadata for the skill catalog."""
        repo = SkillRepository(config)
        return repo.catalog_info()

    def update_all_skills(self, conn: sqlite3.Connection, config: AppConfig) -> list[str]:
        """Check for and install updates for all repository skills."""
        repo = SkillRepository(config)
        available = {str(item["id"]): item for item in repo.list_available()}
        installed = self._registry.list_installed(conn)
        
        updated_ids = []
        for record in installed:
            if record.source_type != "repository":
                continue
            repo_item = available.get(record.skill_id)
            if not repo_item:
                continue
                
            latest_version = str(repo_item.get("latest_version") or repo_item.get("version") or "1.0.0")
            if latest_version != record.version:
                try:
                    self._installer.install_skill(conn, config, record.skill_id, ensure_initialized=False)
                    updated_ids.append(record.skill_id)
                except Exception as e:
                    logging.error(f"Failed to update skill {record.skill_id}: {e}")
                    continue
                    
        return updated_ids

    def sync_repository_skills(self, conn: sqlite3.Connection, config: AppConfig) -> None:
        """Refresh already-installed repository skills without auto-installing new ones."""
        repo = SkillRepository(config)
        for item in repo.list_available():
            skill_id = str(item.get("id", "")).strip()
            if not skill_id:
                continue
            try:
                # We only sync if it's already installed
                record = self._registry.get(conn, skill_id)
                if record is not None and record.source_type == "repository":
                    self._installer.install_skill(conn, config, skill_id, ensure_initialized=False)
            except Exception as exc:
                logging.error(f"Failed to sync repository skill {skill_id!r}: {exc}")
                continue
