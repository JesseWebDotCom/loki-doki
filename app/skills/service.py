"""High-level skill runtime service."""

from __future__ import annotations

import shutil
import sqlite3
import time
import asyncio
import io
import json
import zipfile
import logging
from pathlib import Path
from typing import Any, Optional, Union

from app.catalog import bytes_to_data_url, download_catalog_bytes
from app.config import AppConfig
from app.skills.context import build_skill_context
from app.skills.loader import SkillLoader
from app.skills.manager import SkillManager
from app.skills.manifest import load_manifest, validate_manifest
from app.skills.registry import SkillRegistry
from app.skills.repository import SkillRepository
from app.skills.response import clarification_reply
from app.skills.router import SkillRouter
from app.skills.types import RouteCandidate, RouteDecision
from . import state_store, storage as storage_module

SKILL_FALLBACKS: dict[str, tuple[tuple[str, str], ...]] = {
    "tv_shows": (("wikipedia", "lookup_article"), ("web_search", "search")),
    "wikipedia": (("web_search", "search"),),
    "movies": (("wikipedia", "lookup_article"), ("web_search", "search")),
}


class SkillInstallError(RuntimeError):
    """Raised when a skill package cannot be installed."""


class SkillExecutionError(RuntimeError):
    """Raised when the skill runtime cannot execute a request."""


class SkillService:
    """Facade for storage, routing, loading, and execution."""

    def __init__(self) -> None:
        self._router = SkillRouter()
        self._loader = SkillLoader()
        self._manager = SkillManager(self._loader)

    def initialize(self, conn: sqlite3.Connection, config: AppConfig) -> None:
        """Initialize skill tables and built-in system skills."""
        storage_module.initialize_skill_tables(conn)
        state_store.initialize_skill_state_tables(conn)
        self._registry(config).sync_system_skills(conn)
        self._sync_default_repository_skills(conn, config)

    def list_installed(self, conn: sqlite3.Connection, config: AppConfig) -> list[dict[str, Any]]:
        """Return installed skill payloads without per-user context details."""
        self.initialize(conn, config)
        payload: list[dict[str, Any]] = []
        for record in self._registry(config).list_installed(conn):
            definition = validate_manifest(record.manifest)
            item = record.to_dict()
            item["accounts"] = [account.to_dict() for account in storage_module.list_skill_accounts(conn, record.skill_id)]
            item["shared_context_fields"] = [field.to_dict() for field in definition.shared_context_fields]
            item["account_context_fields"] = [field.to_dict() for field in definition.account_context_fields]
            item["shared_context"] = self._shared_context_with_defaults(definition, {})
            payload.append(item)
        return payload

    def list_installed_for_user(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Return installed skill payloads plus context schemas for one user."""
        self.initialize(conn, config)
        records = self._registry(config).list_installed(conn)
        shared_contexts = self._shared_contexts(conn, current_user["id"])
        payload: list[dict[str, Any]] = []
        for record in records:
            definition = validate_manifest(record.manifest)
            item = record.to_dict()
            item["accounts"] = [account.to_dict() for account in storage_module.list_skill_accounts(conn, record.skill_id)]
            item["shared_context_fields"] = [field.to_dict() for field in definition.shared_context_fields]
            item["account_context_fields"] = [field.to_dict() for field in definition.account_context_fields]
            item["shared_context"] = self._shared_context_with_defaults(
                definition,
                shared_contexts.get(record.skill_id, {}),
            )
            payload.append(item)
        return payload

    def list_skills(self, conn: sqlite3.Connection, config: AppConfig) -> dict[str, Any]:
        """Return both installed and available repository skills."""
        self.initialize(conn, config)
        return {
            "installed": self.list_installed(conn, config),
            "available": self.list_available(conn, config),
            "catalog_info": self.catalog_info(config),
        }

    def list_available(self, conn: sqlite3.Connection, config: AppConfig) -> list[dict[str, Any]]:
        """Return skill repository entries plus install state."""
        self.initialize(conn, config)
        installed_ids = {record.skill_id for record in self._registry(config).list_installed(conn)}
        items: list[dict[str, Any]] = []
        for item in self._repository(config).list_available():
            items.append({**item, "installed": str(item.get("id")) in installed_ids})
        return items

    def catalog_info(self, config: AppConfig) -> dict[str, str]:
        """Return repository-level metadata for the skill catalog."""
        return self._repository(config).catalog_info()

    def install_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
        *,
        ensure_initialized: bool = True,
    ) -> dict[str, Any]:
        """Install one packaged skill from the repository catalog."""
        if ensure_initialized:
            self.initialize(conn, config)
        storage_module.unsuppress_repository_skill(conn, skill_id)
        repo_item = self._repository(config).get(skill_id)
        if repo_item is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not present in the repository index.")
        definition, install_dir, logo = self._install_repository_skill_package(conn, config, repo_item)
        self._persist_installed_skill(
            conn,
            definition=definition,
            enabled=definition.enabled_by_default,
            install_dir=install_dir,
            logo=logo,
        )
        self._loader.clear(definition.skill_id)
        if definition.account_mode != "none":
            self._refresh_skill_health(conn, definition.skill_id)
        return self._require_skill_dict(conn, config, definition.skill_id)

    def uninstall_skill(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
    ) -> None:
        """Remove one installed non-system skill."""
        self.initialize(conn, config)
        record = self._registry(config).get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        if record.system:
            raise SkillInstallError("Built-in system skills cannot be uninstalled.")
        if record.source_type == "repository":
            storage_module.suppress_repository_skill(conn, skill_id)
        source_ref = Path(record.source_ref)
        if source_ref.exists():
            install_dir = source_ref.parent
            if install_dir.exists():
                shutil.rmtree(install_dir, ignore_errors=True)
        storage_module.delete_installed_skill(conn, skill_id)
        self._loader.clear(skill_id)

    def update_all_skills(self, conn: sqlite3.Connection, config: AppConfig) -> dict[str, Any]:
        """Check for and install updates for all repository skills."""
        self.initialize(conn, config)
        available = {str(item["id"]): item for item in self._repository(config).list_available()}
        installed = self._registry(config).list_installed(conn)
        
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
                    self.install_skill(conn, config, record.skill_id, ensure_initialized=False)
                    updated_ids.append(record.skill_id)
                except SkillInstallError:
                    continue
                    
        return {
            "ok": True,
            "updated_count": len(updated_ids),
            "updated_ids": updated_ids,
            "installed": self.list_installed_for_user(conn, config, {"id": "admin"}), # Fallback user
        }

    def update_skill(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str) -> dict[str, Any]:
        """Force reinstall one skill from the repository."""
        self.initialize(conn, config)
        # Simply re-installing performs an update since it overwrites the local copy with the latest repo package
        return self.install_skill(conn, config, skill_id, ensure_initialized=False)

    def set_enabled(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
        enabled: bool,
    ) -> dict[str, Any]:
        """Enable or disable one installed skill."""
        self.initialize(conn, config)
        record = self._registry(config).get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        if record.system and not enabled:
            raise SkillInstallError("Built-in system skills cannot be disabled.")
        storage_module.set_skill_enabled(conn, skill_id, enabled)
        return self._require_skill_dict(conn, config, skill_id)

    def save_account(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
        label: str,
        account_config: dict[str, Any],
        account_context: Optional[dict[str, Any]] = None,
        *,
        enabled: bool = True,
        is_default: bool = False,
        account_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Create or update one skill account."""
        self.initialize(conn, config)
        storage_module.upsert_skill_account(
            conn,
            skill_id=skill_id,
            label=label,
            config=account_config,
            context=account_context,
            enabled=enabled,
            is_default=is_default,
            account_id=account_id,
        )
        self._refresh_skill_health(conn, skill_id)
        return [account.to_dict() for account in storage_module.list_skill_accounts(conn, skill_id)]

    def test_account_connection(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_id: str,
        account_id: str,
    ) -> dict[str, Any]:
        """Run a read-only connection test for one skill account."""
        self.initialize(conn, config)
        record = self._registry(config).get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        account = storage_module.get_skill_account(conn, skill_id, account_id)
        if account is None:
            raise SkillInstallError(f"Account {account_id!r} was not found for skill {skill_id!r}.")
        skill = self._loader.load(record)
        if not hasattr(skill, "test_connection"):
            raise SkillInstallError(f"Skill {skill_id!r} does not support read-only connection tests.")
        try:
            payload = asyncio.run(
                skill.test_connection(
                    {
                        "account_id": account.account_id,
                        "label": account.label,
                        "config": dict(account.config),
                        "context": dict(account.context),
                    }
                )
            )
        except NotImplementedError as exc:
            raise SkillInstallError(str(exc)) from exc
        status = str(payload.get("status") or "error")
        detail = str(payload.get("detail") or "Connection test failed.")
        storage_module.replace_skill_account_health(conn, skill_id, account_id, status, detail)
        if status == "ok" and not record.enabled:
            storage_module.set_skill_enabled(conn, skill_id, True)
        self._refresh_skill_health(conn, skill_id)
        refreshed_account = storage_module.get_skill_account(conn, skill_id, account_id)
        return {
            "ok": status == "ok",
            "skill_id": skill_id,
            "account": None if refreshed_account is None else refreshed_account.to_dict(),
            "status": status,
            "detail": detail,
            "data": dict(payload.get("data") or {}),
        }

    def save_shared_context(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        skill_id: str,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        """Save per-user shared context for one skill."""
        self.initialize(conn, config)
        record = self._registry(config).get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        definition = validate_manifest(record.manifest)
        allowed_keys = {field.key for field in definition.shared_context_fields}
        filtered = {key: values.get(key, "") for key in allowed_keys}
        shared_contexts = self._shared_contexts(conn, current_user["id"])
        shared_contexts[skill_id] = filtered
        db_key = "skill_shared_context"
        from app import db

        db.set_user_setting(conn, current_user["id"], db_key, shared_contexts)
        return filtered

    def route_and_execute(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        profile: str,
        message: str,
        *,
        turn_id: str = "",
        history: Optional[list[dict[str, str]]] = None,
    ) -> Optional[dict[str, Any]]:
        """Route a message through the skill runtime when applicable."""
        self.initialize(conn, config)
        runtime_context = build_skill_context(conn, current_user, profile)
        installed = self._registry(config).list_installed(conn)
        route = self._router.route(message, installed, runtime_context, history=history)
        if route.outcome == "no_skill":
            return None
        if route.outcome == "clarify":
            reply, card = clarification_reply(route.reason)
            res_meta = {
                "request_type": "skill_clarification",
                "route": "skill_router_clarify",
                "reason": route.reason,
                "turn_id": turn_id,
                "voice_summary": reply,
                "skill_id": "none",
                "action": "none",
            }
            return {
                "message": {
                    "role": "assistant",
                    "content": reply,
                    "meta": {
                        **res_meta,
                        "card": card,
                        "skill_result": {},
                    },
                },
                "route": route.to_dict(),
                "result": {
                    "ok": False,
                    "skill_id": "none",
                    "action": "none",
                    "route": route.to_dict(),
                    "result": {},
                    "reply": reply,
                    "card": card,
                    "meta": res_meta,
                },
            }
        if route.candidate is None:
            raise SkillExecutionError("Skill router returned a skill call without a candidate.")
        execution = self._execute_with_fallbacks(
            conn,
            config,
            runtime_context,
            message,
            route,
            turn_id=turn_id,
        )
        return {
            "message": {
                "role": "assistant",
                "content": execution.reply,
                "meta": {
                    **execution.meta,
                    "card": execution.card,
                    "skill_result": execution.result,
                },
            },
            "route": execution.route.to_dict(),
            "result": execution.to_dict(),
        }

    def _execute_with_fallbacks(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        runtime_context: dict[str, Any],
        message: str,
        route: RouteDecision,
        *,
        turn_id: str = "",
    ):
        """Execute one route and walk configured fallback skills on failure."""
        execution = self._execute_route(conn, config, runtime_context, message, route, turn_id=turn_id)
        attempts = [execution.meta["route"]]
        if execution.ok:
            execution.meta["fallback_attempts"] = attempts
            return execution
        fallback_chain = SKILL_FALLBACKS.get(execution.skill_id, ())
        for fallback_skill_id, fallback_action in fallback_chain:
            if self._registry(config).get(conn, fallback_skill_id) is None:
                continue
            fallback_route = self._fallback_route(
                current_route=route,
                fallback_skill_id=fallback_skill_id,
                fallback_action=fallback_action,
                message=message,
            )
            if fallback_route is None:
                continue
            fallback_execution = self._execute_route(conn, config, runtime_context, message, fallback_route, turn_id=turn_id)
            attempts.append(fallback_execution.meta["route"])
            if fallback_execution.ok:
                fallback_execution.meta["fallback_attempts"] = attempts
                fallback_execution.meta["fallback_from"] = execution.meta["route"]
                return fallback_execution
        execution.meta["fallback_attempts"] = attempts
        return execution

    def _execute_route(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        runtime_context: dict[str, Any],
        message: str,
        route: RouteDecision,
        *,
        turn_id: str = "",
    ):
        """Execute one explicit route decision."""
        if route.candidate is None:
            raise SkillExecutionError("Skill route candidate is required for execution.")
        record = self._registry(config).get(conn, route.candidate.skill_id)
        if record is None:
            raise SkillExecutionError(f"Installed skill {route.candidate.skill_id!r} was not found.")
        return self._manager.execute(
            conn,
            record,
            route,
            runtime_context,
            message,
            str(config.database_path),
            turn_id=turn_id,
        )

    def _fallback_route(
        self,
        *,
        current_route: RouteDecision,
        fallback_skill_id: str,
        fallback_action: str,
        message: str,
    ) -> Optional[RouteDecision]:
        """Return one synthetic route for a fallback skill/action."""
        if current_route.candidate is None:
            return None
        extracted_entities = self._fallback_entities(fallback_action, message)
        return RouteDecision(
            outcome="skill_call",
            reason=f"Fallback from {current_route.candidate.skill_id}.{current_route.candidate.action}",
            candidate=RouteCandidate(
                skill_id=fallback_skill_id,
                action=fallback_action,
                score=0.0,
                reason=f"fallback:{current_route.candidate.skill_id}",
                extracted_entities=extracted_entities,
            ),
            alternatives=(),
        )

    def _fallback_entities(self, action: str, message: str) -> dict[str, Any]:
        """Return minimal entity payloads for fallback execution."""
        cleaned = " ".join(message.lower().strip().split())
        if action == "search":
            return {"query": cleaned, "num_results": 5}
        return {}

    def inspect_route(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        profile: str,
        message: str,
        history: Optional[list[dict[str, str]]] = None,
    ) -> dict[str, Any]:
        """Return routing analysis for one request without executing it."""
        self.initialize(conn, config)
        runtime_context = build_skill_context(conn, current_user, profile)
        records = self._registry(config).list_installed(conn)
        return self._router.route(message, records, runtime_context, history=history).to_dict()

    def test_route(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        profile: str,
        message: str,
    ) -> dict[str, Any]:
        """Inspect and execute one skill request without saving chat history."""
        self.initialize(conn, config)
        runtime_context = build_skill_context(conn, current_user, profile)
        started = time.perf_counter()
        route = self._router.route(message, self._registry(config).list_installed(conn), runtime_context)
        if route.outcome == "no_skill":
            return {
                "route": route.to_dict(),
                "message": None,
                "timing_ms": round((time.perf_counter() - started) * 1000, 2),
                "context": self._public_runtime_context(runtime_context),
            }
        execution = self.route_and_execute(conn, config, current_user, profile, message)
        return {
            "route": route.to_dict(),
            "message": None if execution is None else execution["message"],
            "timing_ms": round((time.perf_counter() - started) * 1000, 2),
            "context": self._public_runtime_context(runtime_context),
            "result": None if execution is None else execution.get("result"),
        }

    def _registry(self, config: AppConfig) -> SkillRegistry:
        """Return the registry for the current app config."""
        return SkillRegistry(config.skills_builtin_dir)

    def _repository(self, config: AppConfig) -> SkillRepository:
        """Return the configured repository index."""
        return SkillRepository(config)

    def _resolve_package_dir(self, config: AppConfig, repo_item: dict[str, Any]) -> Optional[Path]:
        """Return the bundled package directory when one exists locally."""
        package_dir_value = str(repo_item.get("package_dir", "")).strip()
        if not package_dir_value:
            return None
        package_dir = Path(package_dir_value)
        if not package_dir.is_absolute():
            package_dir = (config.root_dir / package_dir).resolve()
        return package_dir

    def _load_repository_definition(self, config: AppConfig, repo_item: dict[str, Any]) -> Any:
        """Load the manifest definition for one repository item."""
        package_dir = self._resolve_package_dir(config, repo_item)
        if package_dir is not None:
            manifest_path = package_dir / "manifest.json"
            if manifest_path.exists():
                return validate_manifest(load_manifest(manifest_path))
        download_url = str(repo_item.get("download_url") or "").strip()
        if not download_url:
            raise SkillInstallError(f"Skill {repo_item.get('id')!r} is missing a package source.")
        archive = zipfile.ZipFile(io.BytesIO(download_catalog_bytes(download_url)))
        with archive:
            manifest_name = self._required_archive_member(archive, "manifest.json")
            return validate_manifest(json.loads(archive.read(manifest_name).decode("utf-8")))

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
        self._install_dependencies(conn, config, definition.raw_manifest.get("skill_dependencies", {}))
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
            self._install_dependencies(conn, config, definition.raw_manifest.get("skill_dependencies", {}))
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
            logging.warning(f"Skill package logo was not found: {logo_name}")
            return ""
        return bytes_to_data_url(logo_path.name, logo_path.read_bytes())

    def _logo_from_archive(self, archive: zipfile.ZipFile, manifest: dict[str, Any]) -> str:
        """Return the logo data URL for one downloaded skill package."""
        logo_name = str(manifest.get("logo_path") or "").strip()
        if not logo_name:
            return ""
        member_name = self._matching_archive_member(archive, logo_name)
        if not member_name:
            logging.warning(f"Skill package is missing a logo image: {logo_name}")
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

    def _install_dependencies(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        skill_dependencies: dict[str, Any],
    ) -> None:
        """Ensure required skill dependencies are installed."""
        required = list(skill_dependencies.get("required", []))
        for dependency in required:
            dependency_id = str(dependency["id"] if isinstance(dependency, dict) else dependency).strip()
            if not dependency_id:
                continue
            if storage_module.get_installed_skill(conn, dependency_id) is not None:
                continue
            self.install_skill(conn, config, dependency_id, ensure_initialized=False)

    def _sync_default_repository_skills(self, conn: sqlite3.Connection, config: AppConfig) -> None:
        """Refresh already-installed repository skills without auto-installing new ones."""
        for item in self._repository(config).list_available():
            skill_id = str(item.get("id", "")).strip()
            if not skill_id:
                continue
            try:
                package_dir = self._resolve_package_dir(config, item)
                if package_dir is None and not str(item.get("download_url") or "").strip():
                    continue
                definition = self._load_repository_definition(config, item)
                installed = storage_module.get_installed_skill(conn, skill_id)
                if installed is not None and installed.source_type == "repository":
                    self._sync_repository_skill_record(conn, config, item, definition, installed.enabled)
            except Exception as exc:
                logging.error(f"Failed to sync repository skill {skill_id!r}: {exc}")
                continue

    def _sync_repository_skill_record(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        repo_item: dict[str, Any],
        definition: Any,
        enabled: bool,
    ) -> None:
        """Refresh one installed repository skill from the local package."""
        refreshed_definition, install_dir, logo = self._install_repository_skill_package(conn, config, repo_item)
        self._persist_installed_skill(
            conn,
            definition=refreshed_definition,
            enabled=enabled,
            install_dir=install_dir,
            logo=logo,
        )
        if definition.account_mode != "none":
            self._refresh_skill_health(conn, definition.skill_id)

    def _require_skill_dict(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str) -> dict[str, Any]:
        """Return a required installed skill as a JSON payload."""
        record = self._registry(config).get(conn, skill_id)
        if record is None:
            raise SkillInstallError(f"Skill {skill_id!r} is not installed.")
        definition = validate_manifest(record.manifest)
        payload = record.to_dict()
        payload["accounts"] = [account.to_dict() for account in storage_module.list_skill_accounts(conn, skill_id)]
        payload["shared_context_fields"] = [field.to_dict() for field in definition.shared_context_fields]
        payload["account_context_fields"] = [field.to_dict() for field in definition.account_context_fields]
        return payload

    def _shared_contexts(self, conn: sqlite3.Connection, user_id: str) -> dict[str, dict[str, Any]]:
        """Return per-user shared context keyed by skill id."""
        from app import db

        stored = db.get_user_setting(conn, user_id, "skill_shared_context", {})
        return dict(stored)

    def _refresh_skill_health(self, conn: sqlite3.Connection, skill_id: str) -> None:
        """Derive top-level skill health from its configured accounts."""
        accounts = storage_module.list_skill_accounts(conn, skill_id)
        if not accounts:
            storage_module.replace_skill_health(conn, skill_id, "unknown", "No accounts configured.")
            return
        if any(account.health_status == "error" for account in accounts):
            detail = next((account.health_detail for account in accounts if account.health_status == "error"), "One or more accounts failed.")
            storage_module.replace_skill_health(conn, skill_id, "error", detail)
            return
        if any(account.health_status == "ok" for account in accounts):
            detail = next((account.health_detail for account in accounts if account.health_status == "ok"), "At least one account is healthy.")
            storage_module.replace_skill_health(conn, skill_id, "ok", detail)
            return
        detail = next((account.health_detail for account in accounts if account.health_detail), "Accounts have not been tested yet.")
        storage_module.replace_skill_health(conn, skill_id, "unknown", detail)

    def _public_runtime_context(self, runtime_context: dict[str, Any]) -> dict[str, Any]:
        """Return a JSON-safe runtime context payload for inspection views."""
        account_manager = runtime_context.get("accounts")
        account_summary: dict[str, list[dict[str, Any]]] = {}
        if account_manager is not None:
            for skill_id in ("home_assistant", "weather", "web_search", "movies", "family_calendar", "reminders", "shopping_list"):
                accounts = account_manager.list_accounts(skill_id)
                if accounts:
                    account_summary[skill_id] = [
                        {
                            "id": account.account_id,
                            "label": account.label,
                            "enabled": account.enabled,
                            "is_default": account.is_default,
                        }
                        for account in accounts
                    ]
        payload = {
            "profile": str(runtime_context.get("profile", "")),
            "username": str(runtime_context.get("username", "")),
            "display_name": str(runtime_context.get("display_name", "")),
            "shared_contexts": dict(runtime_context.get("shared_contexts", {})),
        }
        if account_summary:
            payload["accounts"] = account_summary
        return payload

    def _shared_context_with_defaults(
        self,
        definition: Any,
        stored_values: dict[str, Any],
    ) -> dict[str, Any]:
        """Merge persisted shared context values with field defaults."""
        merged = {field.key: field.default_value for field in definition.shared_context_fields}
        merged.update(dict(stored_values))
        return merged


skill_service = SkillService()
