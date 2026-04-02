"""Registry access for installed and built-in skills."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.catalog import bytes_to_data_url
from app.skills.manifest import load_manifest, validate_manifest
from . import storage as storage_module
from app.skills.types import InstalledSkillRecord


class SkillRegistry:
    """Keep installed-skill state and built-in system skills in sync."""

    def __init__(self, builtins_dir: Path):
        self._builtins_dir = builtins_dir

    def sync_system_skills(self, conn: sqlite3.Connection) -> None:
        """Ensure built-in system skills are installed in SQLite."""
        if not self._builtins_dir.exists():
            return
        for manifest_path in sorted(self._builtins_dir.glob("*/manifest.json")):
            definition = validate_manifest(load_manifest(manifest_path))
            skill_dir = manifest_path.parent
            skill_path = skill_dir / "skill.py"
            logo = self._builtin_logo(skill_dir, definition.raw_manifest)
            storage_module.upsert_installed_skill(
                conn,
                skill_id=definition.skill_id,
                version=definition.version,
                title=definition.title,
                domain=definition.domain,
                description=definition.description,
                logo=logo,
                manifest=definition.raw_manifest,
                enabled=definition.enabled_by_default,
                system=definition.system,
                load_type=definition.load_type,
                source_type="builtin",
                source_ref=skill_path,
            )

    def list_installed(self, conn: sqlite3.Connection) -> list[InstalledSkillRecord]:
        """Return all installed skills."""
        return storage_module.list_installed_skills(conn)

    def get(self, conn: sqlite3.Connection, skill_id: str) -> Optional[InstalledSkillRecord]:
        """Return one installed skill."""
        return storage_module.get_installed_skill(conn, skill_id)

    def _builtin_logo(self, skill_dir: Path, manifest: dict[str, object]) -> str:
        """Return a data URL for one built-in skill logo when present."""
        logo_name = str(manifest.get("logo_path") or "").strip()
        if not logo_name:
            return ""
        logo_path = skill_dir / logo_name
        if not logo_path.exists():
            return ""
        return bytes_to_data_url(logo_path.name, logo_path.read_bytes())
