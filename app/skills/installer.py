"""Skill installer and dependency resolver."""

from __future__ import annotations

import io
import json
import logging
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Optional

from app.catalog import bytes_to_data_url, download_catalog_bytes
from app.config import AppConfig
from app.skills import storage as storage_module
from app.skills.manifest import load_manifest, validate_manifest
from app.skills.registry import SkillRegistry


class SkillInstallError(RuntimeError):
    """Raised when a skill package cannot be installed."""


class SkillInstaller:
    """Handle skill installation, removal, and dependency resolution."""

    def __init__(self, registry: SkillRegistry) -> None:
        self._registry = registry

    def install_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
        *,
        ensure_initialized: bool = True,
    ) -> None:
        """Install one packaged skill from the repository catalog."""
        from app.skills.repository import SkillRepository
        repo = SkillRepository(config)
        repo_item = repo.get(skill_id)
        if repo_item is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not present in the repository index.")
        
        storage_module.unsuppress_repository_skill(conn, skill_id)
        definition, install_dir, logo = self._install_repository_skill_package(conn, config, repo_item)
        self._persist_installed_skill(
            conn,
            definition=definition,
            enabled=definition.enabled_by_default,
            install_dir=install_dir,
            logo=logo,
        )

    def uninstall_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
    ) -> None:
        """Remove one installed non-system skill."""
        record = self._registry.get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        if record.system:
            raise SkillInstallError("Built-in system skills cannot be uninstalled.")
        if record.source_type == "repository":
            storage_module.suppress_repository_skill(conn, skill_id)
        
        source_ref = Path(record.source_ref)
        if source_ref.exists():
            install_dir = source_ref.parent
            if install_dir.exists() and install_dir.name == record.skill_id:
                shutil.rmtree(install_dir, ignore_errors=True)
                
        storage_module.delete_installed_skill(conn, skill_id)

    def _install_repository_skill_package(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        repo_item: dict[str, Any],
    ) -> tuple[Any, Path, str]:
        """Install one repository skill package and return its definition, install dir, and logo."""
        package_dir = self._resolve_package_dir(config, repo_item)
        if package_dir is not None:
            return self._install_local_repository_skill(conn, config, package_dir)
        download_url = str(repo_item.get("download_url") or "").strip()
        if not download_url:
            raise SkillInstallError(f"Skill {repo_item.get('id')!r} is missing a package source.")
        return self._install_remote_repository_skill(conn, config, download_url)

    def _resolve_package_dir(self, config: AppConfig, repo_item: dict[str, Any]) -> Optional[Path]:
        """Return the bundled package directory when one exists locally."""
        package_dir_value = str(repo_item.get("package_dir", "")).strip()
        if not package_dir_value:
            return None
        package_dir = Path(package_dir_value)
        if not package_dir.is_absolute():
            package_dir = (config.root_dir / package_dir).resolve()
        return package_dir

    def _install_local_repository_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        package_dir: Path,
    ) -> tuple[Any, Path, str]:
        """Install one bundled repository skill package."""
        manifest_path = package_dir / "manifest.json"
        skill_path = package_dir / "skill.py"
        if not manifest_path.exists() or not skill_path.exists():
            raise SkillInstallError(f"Skill package at {package_dir} is incomplete.")
        definition = validate_manifest(load_manifest(manifest_path))
        
        # Dependency resolution
        self.resolve_dependencies(conn, config, definition)
        
        install_dir = config.skills_installed_dir / definition.skill_id
        if install_dir.exists():
            shutil.rmtree(install_dir)
        shutil.copytree(package_dir, install_dir)
        logo = self._logo_from_local_package(package_dir, definition.raw_manifest)
        return definition, install_dir, logo

    def _install_remote_repository_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        download_url: str,
    ) -> tuple[Any, Path, str]:
        """Install one downloaded repository skill package."""
        payload = download_catalog_bytes(download_url)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            manifest_name = self._required_archive_member(archive, "manifest.json")
            skill_name = self._required_archive_member(archive, "skill.py")
            definition = validate_manifest(json.loads(archive.read(manifest_name).decode("utf-8")))
            
            # Dependency resolution
            self.resolve_dependencies(conn, config, definition)
            
            install_dir = config.skills_installed_dir / definition.skill_id
            if install_dir.exists():
                shutil.rmtree(install_dir)
            install_dir.mkdir(parents=True, exist_ok=True)
            self._extract_archive_file(archive, manifest_name, install_dir / "manifest.json")
            self._extract_archive_file(archive, skill_name, install_dir / "skill.py")
            for name in archive.namelist():
                normalized = Path(name)
                if normalized.name in {"manifest.json", "skill.py"} or name.endswith("/"):
                    continue
                target_path = install_dir / normalized.name
                self._extract_archive_file(archive, name, target_path)
            logo = self._logo_from_archive(archive, definition.raw_manifest)
            return definition, install_dir, logo

    def resolve_dependencies(self, conn: sqlite3.Connection, config: AppConfig, definition: Any) -> None:
        """Resolve both skill and runtime pip dependencies."""
        self._install_skill_dependencies(conn, config, definition.skill_dependencies)
        self._install_runtime_dependencies(definition)

    def _install_skill_dependencies(self, conn: sqlite3.Connection, config: AppConfig, skill_dependencies: dict[str, Any]) -> None:
        """Ensure required skill dependencies are installed."""
        required = list(skill_dependencies.get("required", []))
        for dependency in required:
            dependency_id = str(dependency["id"] if isinstance(dependency, dict) else dependency).strip()
            if not dependency_id:
                continue
            if storage_module.get_installed_skill(conn, dependency_id) is not None:
                continue
            self.install_skill(conn, config, dependency_id, ensure_initialized=False)

    def _install_runtime_dependencies(self, definition: Any) -> None:
        """Run pip install for any runtime dependencies listed in the manifest."""
        runtime_deps = definition.runtime_dependencies
        if not runtime_deps:
            return

        packages = []
        for dep in runtime_deps:
            pkg = dep.get("package")
            version = dep.get("version")
            if pkg:
                spec = f"{pkg}{version}" if version else pkg
                packages.append(spec)
        
        if not packages:
            return

        logging.info(f"Installing runtime dependencies for {definition.skill_id}: {', '.join(packages)}")
        try:
            # We use the current python executable to ensure we install into the same environment
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", *packages],
                capture_output=True,
                text=True,
                check=True
            )
            logging.debug(f"Pip output: {result.stdout}")
        except subprocess.CalledProcessError as e:
            logging.error(f"Failed to install runtime dependencies for {definition.skill_id}: {e.stderr}")
            # We don't necessarily want to fail the whole install if one package fails, 
            # as it might already be present but mismatched, or non-critical.
            # However, for now, let's just log it.

    def _persist_installed_skill(
        self,
        conn: sqlite3.Connection,
        *,
        definition: Any,
        enabled: bool,
        install_dir: Path,
        logo: str,
    ) -> None:
        """Persist one installed repository skill record."""
        storage_module.upsert_installed_skill(
            conn,
            skill_id=definition.skill_id,
            version=definition.version,
            title=definition.title,
            domain=definition.domain,
            description=definition.description,
            logo=logo,
            manifest=definition.raw_manifest,
            enabled=enabled,
            system=definition.system,
            load_type=definition.load_type,
            source_type="repository",
            source_ref=install_dir / "skill.py",
        )

    def _logo_from_local_package(self, package_dir: Path, manifest: dict[str, Any]) -> str:
        """Return the logo data URL for one bundled skill package."""
        logo_name = str(manifest.get("logo_path") or "").strip()
        if not logo_name:
            return ""
        logo_path = package_dir / logo_name
        if not logo_path.exists():
            return ""
        return bytes_to_data_url(logo_path.name, logo_path.read_bytes())

    def _logo_from_archive(self, archive: zipfile.ZipFile, manifest: dict[str, Any]) -> str:
        """Return the logo data URL for one downloaded skill package."""
        logo_name = str(manifest.get("logo_path") or "").strip()
        if not logo_name:
            return ""
        member_name = self._matching_archive_member(archive, logo_name)
        if not member_name:
            return ""
        return bytes_to_data_url(Path(member_name).name, archive.read(member_name))

    def _required_archive_member(self, archive: zipfile.ZipFile, filename: str) -> str:
        """Return one required archive member by basename."""
        member_name = self._matching_archive_member(archive, filename)
        if not member_name:
            raise SkillInstallError(f"Skill package is missing {filename}.")
        return member_name

    def _matching_archive_member(self, archive: zipfile.ZipFile, filename: str) -> str:
        """Return one archive member by exact or basename match."""
        for name in archive.namelist():
            if name == filename or Path(name).name == Path(filename).name:
                return name
        return ""

    def _extract_archive_file(self, archive: zipfile.ZipFile, member_name: str, target_path: Path) -> None:
        """Write one archive file to disk."""
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(archive.read(member_name))
