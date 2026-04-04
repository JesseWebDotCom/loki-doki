"""High-level skill runtime service (facade)."""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Optional, Callable, Awaitable

from app.config import AppConfig
from app.skills import state_store, storage as storage_module
from app.skills.context import build_skill_context
from app.skills.installer import SkillInstaller, SkillInstallError
from app.skills.loader import SkillLoader
from app.skills.manager import SkillManager
from app.skills.manifest import validate_manifest
from app.skills.normalizer import Normalizer
from app.skills.registry import SkillRegistry
from app.skills.response import clarification_reply
from app.skills.router import SkillRouter
from app.skills.store import SkillStore
from app.skills.tfidf_index import InvertedIndex
from app.skills.types import RouteCandidate, RouteDecision

SKILL_FALLBACKS: dict[str, tuple[tuple[str, str], ...]] = {
    "tv_shows": (("wikipedia", "lookup_article"), ("web_search", "search")),
    "wikipedia": (("web_search", "search"),),
    "movies": (("wikipedia", "lookup_article"), ("web_search", "search")),
}


class SkillExecutionError(RuntimeError):
    """Raised when the skill runtime cannot execute a request."""


class SkillService:
    """Facade for storage, routing, loading, and execution."""

    def __init__(self) -> None:
        self._normalizer = Normalizer()
        self._index = InvertedIndex(self._normalizer)
        self._router = SkillRouter(self._index)
        self._loader = SkillLoader()
        self._manager = SkillManager(self._loader)

    def _registry(self, config: AppConfig) -> SkillRegistry:
        return SkillRegistry(config.skills_builtin_dir)

    def _installer(self, config: AppConfig) -> SkillInstaller:
        return SkillInstaller(self._registry(config))

    def _store(self, config: AppConfig) -> SkillStore:
        return SkillStore(self._registry(config), self._installer(config))

    def initialize(self, conn: sqlite3.Connection, config: AppConfig) -> None:
        """Initialize skill tables and built-in system skills."""
        storage_module.initialize_skill_tables(conn)
        state_store.initialize_skill_state_tables(conn)
        registry = self._registry(config)
        registry.sync_system_skills(conn)
        self._store(config).sync_repository_skills(conn, config)
        
        # Warm up the routing index
        self._index.build(registry.list_installed(conn))

    def list_skills(self, conn: sqlite3.Connection, config: AppConfig) -> dict[str, Any]:
        """Return both installed and available repository skills."""
        self.initialize(conn, config)
        return {
            "installed": self.list_installed(conn, config),
            "available": self._store(config).list_available(conn, config),
            "catalog_info": self._store(config).catalog_info(config),
        }

    def list_installed(self, conn: sqlite3.Connection, config: AppConfig) -> list[dict[str, Any]]:
        """Return basic installed skill payloads."""
        self.initialize(conn, config)
        payload: list[dict[str, Any]] = []
        for record in self._registry(config).list_installed(conn):
            definition = validate_manifest(record.manifest)
            item = record.to_dict()
            item["accounts"] = [account.to_dict() for account in storage_module.list_skill_accounts(conn, record.skill_id)]
            item["shared_context_fields"] = [f.to_dict() for f in definition.shared_context_fields]
            item["account_context_fields"] = [f.to_dict() for f in definition.account_context_fields]
            item["shared_context"] = self._get_shared_context_for_skill(conn, definition, "admin") # Default admin for list_installed
            payload.append(item)
        return payload

    def install_skill(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str) -> dict[str, Any]:
        """Install one skill from the repository."""
        self.initialize(conn, config)
        self._installer(config).install_skill(conn, config, skill_id)
        self._loader.clear(skill_id)
        self._refresh_skill_health(conn, skill_id)
        # Refresh index
        self._index.build(self._registry(config).list_installed(conn))
        return self._require_skill_dict(conn, config, skill_id)

    def uninstall_skill(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str) -> None:
        """Uninstall one skill."""
        self.initialize(conn, config)
        self._installer(config).uninstall_skill(conn, config, skill_id)
        self._loader.clear(skill_id)
        # Refresh index
        self._index.build(self._registry(config).list_installed(conn))

    def update_all_skills(self, conn: sqlite3.Connection, config: AppConfig) -> dict[str, Any]:
        """Update all installed repository skills."""
        self.initialize(conn, config)
        updated_ids = self._store(config).update_all_skills(conn, config)
        return {
            "ok": True,
            "updated_count": len(updated_ids),
            "updated_ids": updated_ids,
            "installed": self.list_installed(conn, config),
        }

    async def route_and_execute(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        profile: str,
        message: str,
        *,
        turn_id: str = "",
        history: Optional[list[dict[str, str]]] = None,
        emit_progress: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> Optional[dict[str, Any]]:
        """Route and execute a request through skills."""
        self.initialize(conn, config)
        runtime_context = build_skill_context(conn, current_user, profile)
        installed = self._registry(config).list_installed(conn)
        route = self._router.route(message, installed, runtime_context, history=history)
        
        if route.outcome == "no_skill":
            return None
        if route.outcome == "clarify":
            reply, card = clarification_reply(route.reason)
            res_meta = self._clarification_meta(reply, route.reason, turn_id)
            return {
                "message": {"role": "assistant", "content": reply, "meta": {**res_meta, "card": card}},
                "route": route.to_dict(),
                "result": {"ok": False, "skill_id": "none", "action": "none", "reply": reply, "card": card, "meta": res_meta},
            }
            
        execution = await self._execute_with_fallbacks(conn, config, runtime_context, message, route, turn_id=turn_id, emit_progress=emit_progress)
        return {
            "message": {
                "role": "assistant",
                "content": execution.reply,
                "meta": {**execution.meta, "card": execution.card, "skill_result": execution.result},
            },
            "route": execution.route.to_dict(),
            "result": execution.to_dict(),
        }

    async def _execute_with_fallbacks(self, conn: sqlite3.Connection, config: AppConfig, runtime_context: dict[str, Any], message: str, route: RouteDecision, turn_id: str = "", emit_progress: Optional[Callable[[str], Awaitable[None]]] = None):
        """Helper for fallback logic."""
        try:
            execution = await self._execute_route(conn, config, runtime_context, message, route, turn_id=turn_id, emit_progress=emit_progress)
        except Exception as exc:
            logging.error(f"Primary skill execution failed: {exc}")
            # Create a "failed" execution so we can trigger fallbacks
            from app.skills.types import SkillExecutionResult
            execution = SkillExecutionResult(ok=False, skill_id=route.candidate.skill_id, action=route.candidate.action, route=route, result={}, reply="", card={}, meta={})

        if execution.ok or execution.skill_id not in SKILL_FALLBACKS:
            return execution
            
        for fb_skill, fb_action in SKILL_FALLBACKS[execution.skill_id]:
            if self._registry(config).get(conn, fb_skill) is None: continue
            fb_route = self._synthetic_route(route, fb_skill, fb_action, message)
            try:
                fb_exec = await self._execute_route(conn, config, runtime_context, message, fb_route, turn_id=turn_id, emit_progress=emit_progress)
                if fb_exec.ok: return fb_exec
            except Exception as exc:
                logging.error(f"Fallback skill {fb_skill} failed: {exc}")
                continue
        return execution

    async def _execute_route(self, conn: sqlite3.Connection, config: AppConfig, runtime_context: dict[str, Any], message: str, route: RouteDecision, turn_id: str = "", emit_progress: Optional[Callable[[str], Awaitable[None]]] = None):
        if route.candidate is None: raise SkillExecutionError("No candidate.")
        record = self._registry(config).get(conn, route.candidate.skill_id)
        if not record: raise SkillExecutionError(f"Skill {route.candidate.skill_id} not found.")
        return await self._manager.execute(conn, record, route, runtime_context, message, str(config.database_path), turn_id=turn_id, emit_progress=emit_progress)

    def _synthetic_route(self, current: RouteDecision, skill_id: str, action: str, message: str) -> RouteDecision:
        entities = {"query": message.strip(), "num_results": 5} if action == "search" else {}
        return RouteDecision(
            outcome="skill_call", 
            reason=f"Fallback", 
            candidate=RouteCandidate(skill_id=skill_id, action=action, score=0.0, reason="fallback", extracted_entities=entities)
        )

    def _require_skill_dict(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str) -> dict[str, Any]:
        record = self._registry(config).get(conn, skill_id)
        if not record: raise ValueError(f"Skill {skill_id} not installed.")
        definition = validate_manifest(record.manifest)
        item = record.to_dict()
        item["accounts"] = [a.to_dict() for a in storage_module.list_skill_accounts(conn, skill_id)]
        item["shared_context_fields"] = [f.to_dict() for f in definition.shared_context_fields]
        item["account_context_fields"] = [f.to_dict() for f in definition.account_context_fields]
        return item

    def _refresh_skill_health(self, conn: sqlite3.Connection, skill_id: str) -> None:
        accounts = storage_module.list_skill_accounts(conn, skill_id)
        if not accounts:
            storage_module.replace_skill_health(conn, skill_id, "unknown", "No accounts.")
            return
        # Simple health check based on account status
        ok = any(a.health_status == "ok" for a in accounts)
        err = any(a.health_status == "error" for a in accounts)
        status = "ok" if ok and not err else "error" if err else "unknown"
        storage_module.replace_skill_health(conn, skill_id, status, "Refreshed.")

    def _get_shared_context_for_skill(self, conn: sqlite3.Connection, definition: Any, user_id: str) -> dict[str, Any]:
        from app import db
        stored = db.get_user_setting(conn, user_id, "skill_shared_context", {})
        skill_context = stored.get(definition.skill_id, {})
        # Merge with defaults
        return {f.key: skill_context.get(f.key, f.default_value) for f in definition.shared_context_fields}

    def _clarification_meta(self, reply: str, reason: str, turn_id: str) -> dict[str, Any]:
        return {
            "request_type": "skill_clarification",
            "route": "skill_router_clarify",
            "reason": reason,
            "turn_id": turn_id,
            "voice_summary": reply,
            "skill_id": "none",
            "action": "none",
        }

    # Passthrough methods for UI/Account management
    def set_enabled(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str, enabled: bool) -> dict[str, Any]:
        storage_module.set_skill_enabled(conn, skill_id, enabled)
        return self._require_skill_dict(conn, config, skill_id)

    def save_account(self, conn: sqlite3.Connection, config: AppConfig, skill_id: str, label: str, config_data: dict, context: dict = None, *, enabled: bool = True, is_default: bool = False, account_id: str = None) -> list[dict]:
        storage_module.upsert_skill_account(conn, skill_id=skill_id, label=label, config=config_data, context=context, enabled=enabled, is_default=is_default, account_id=account_id)
        self._refresh_skill_health(conn, skill_id)
        return [a.to_dict() for a in storage_module.list_skill_accounts(conn, skill_id)]

    def list_skill_accounts(self, conn: sqlite3.Connection, skill_id: str) -> list[dict[str, Any]]:
        """Return all configured accounts for one skill."""
        return [a.to_dict() for a in storage_module.list_skill_accounts(conn, skill_id)]

    def upsert_skill_account(
        self,
        conn: sqlite3.Connection,
        skill_id: str,
        payload_dict: dict[str, Any],
        *,
        account_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create or update one skill account configuration."""
        aid = storage_module.upsert_skill_account(
            conn,
            skill_id=skill_id,
            label=payload_dict.get("label", "New Account"),
            config=payload_dict.get("config", {}),
            enabled=payload_dict.get("enabled", True),
            is_default=payload_dict.get("is_default", False),
            context=payload_dict.get("context", {}),
            account_id=account_id or payload_dict.get("account_id"),
        )
        self._refresh_skill_health(conn, skill_id)
        record = storage_module.get_skill_account(conn, skill_id, aid)
        if not record:
            raise ValueError(f"Failed to upsert skill account {aid} for {skill_id}.")
        return record.to_dict()

    def delete_skill_account(self, conn: sqlite3.Connection, skill_id: str, account_id: str) -> None:
        """Remove one skill account configuration."""
        storage_module.delete_skill_account(conn, skill_id, account_id)
        self._refresh_skill_health(conn, skill_id)

    def set_account_enabled(
        self,
        conn: sqlite3.Connection,
        skill_id: str,
        account_id: str,
        enabled: bool,
    ) -> dict[str, Any]:
        """Enable or disable one skill account."""
        storage_module.set_skill_account_enabled(conn, skill_id, account_id, enabled)
        self._refresh_skill_health(conn, skill_id)
        record = storage_module.get_skill_account(conn, skill_id, account_id)
        if not record:
            raise ValueError(f"Skill account {account_id} not found.")
        return record.to_dict()

    def inspect_route(
        self,
        conn: sqlite3.Connection,
        config: AppConfig,
        current_user: dict[str, Any],
        profile: str,
        message: str,
        *,
        history: Optional[list[dict[str, str]]] = None,
    ) -> dict[str, Any]:
        """Determine which skill would handle a given message."""
        self.initialize(conn, config)
        runtime_context = build_skill_context(conn, current_user, profile)
        installed = self._registry(config).list_installed(conn)
        route = self._router.route(message, installed, runtime_context, history=history)
        return route.to_dict()

    def get_shared_context(self, conn: sqlite3.Connection) -> dict[str, Any]:
        """Return the global shared skill context (via admin settings)."""
        from app import db
        return db.get_user_setting(conn, "admin", "skill_shared_context", {})

    def update_shared_context(self, conn: sqlite3.Connection, values: dict[str, Any]) -> dict[str, Any]:
        """Overwrite the global shared skill context (via admin settings)."""
        from app import db
        db.set_user_setting(conn, "admin", "skill_shared_context", values)
        return values



skill_service = SkillService()

