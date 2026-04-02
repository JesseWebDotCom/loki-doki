"""Skill-related API routes."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app.deps import APP_CONFIG, connection_scope, get_current_user, enforce_admin
from app.models.skills import (
    SkillInstallRequest,
    SkillAccountRequest,
    SkillRouteInspectRequest,
    SkillTestRequest,
    SkillSharedContextRequest,
)
from app.skills import skill_service, SkillInstallError, SkillExecutionError
from app.runtime import runtime_context

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("")
def list_skills_api(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return all available and installed skills."""
    del current_user
    with connection_scope() as connection:
        return skill_service.list_skills(connection, APP_CONFIG)


@router.post("/install")
def install_skill_api(
    payload: SkillInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Download and install one skill package."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        try:
            skill = skill_service.install_skill(connection, APP_CONFIG, payload.skill_id.strip())
            return {"ok": True, "skill": skill, **skill_service.list_skills(connection, APP_CONFIG)}
        except SkillInstallError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{skill_id}/accounts")
def list_skill_accounts_api(
    skill_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return configured accounts for one skill."""
    del current_user
    with connection_scope() as connection:
        accounts = skill_service.list_skill_accounts(connection, skill_id)
        return {"accounts": accounts}


@router.post("/{skill_id}/accounts")
@router.put("/{skill_id}/accounts/{account_id}")
def upsert_skill_account_api(
    skill_id: str,
    payload: SkillAccountRequest,
    account_id: Optional[str] = None,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create or update one skill account configuration."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        try:
            account = skill_service.upsert_skill_account(
                connection,
                skill_id,
                payload.dict(),
                account_id=account_id or payload.account_id,
            )
            return {"ok": True, "account": account}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{skill_id}/accounts/{account_id}")
def delete_skill_account_api(
    skill_id: str,
    account_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one skill account configuration."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        skill_service.delete_skill_account(connection, skill_id, account_id)
        return {"ok": True}


@router.post("/{skill_id}/accounts/{account_id}/enable")
def enable_skill_account_api(
    skill_id: str,
    account_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Enable one skill account."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        account = skill_service.set_account_enabled(connection, skill_id, account_id, True)
        return {"ok": True, "account": account}


@router.post("/{skill_id}/accounts/{account_id}/disable")
def disable_skill_account_api(
    skill_id: str,
    account_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Disable one skill account."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        account = skill_service.set_account_enabled(connection, skill_id, account_id, False)
        return {"ok": True, "account": account}


@router.post("/inspect-route")
def inspect_skill_route_api(
    payload: SkillRouteInspectRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Determine which skill would handle a given message."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        route = skill_service.inspect_route(
            connection,
            APP_CONFIG,
            current_user,
            context["settings"]["profile"],
            payload.message.strip(),
        )
        return {"route": route}


@router.post("/test-run")
def test_skill_run_api(
    payload: SkillTestRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Execute a skill operation manually for testing."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            result = skill_service.route_and_execute(
                connection,
                APP_CONFIG,
                current_user,
                context["settings"]["profile"],
                payload.message.strip(),
            )
            return {"result": result}
        except SkillExecutionError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/shared-context")
def get_skill_shared_context_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the global shared skill context."""
    del current_user
    with connection_scope() as connection:
        return {"values": skill_service.get_shared_context(connection)}


@router.put("/shared-context")
def update_skill_shared_context_api(
    payload: SkillSharedContextRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Overwrite the global shared skill context."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = skill_service.update_shared_context(connection, payload.values)
        return {"ok": True, "values": context}
