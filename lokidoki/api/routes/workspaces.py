"""Workspace CRUD + active-session workspace endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.orchestrator.workspace import (
    DEFAULT_WORKSPACE_ID,
    create_workspace,
    delete_workspace,
    ensure_default_workspace,
    get_session_active_workspace_id,
    get_workspace,
    list_workspaces,
    set_session_active_workspace,
    update_workspace,
)

router = APIRouter()
session_router = APIRouter()


class WorkspaceCreate(BaseModel):
    id: Optional[str] = None
    name: str
    persona_id: str = "default"
    default_mode: str = "standard"
    attached_corpora: list[str] = []
    tone_hint: Optional[str] = None
    memory_scope: str = "workspace"


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    persona_id: Optional[str] = None
    default_mode: Optional[str] = None
    attached_corpora: Optional[list[str]] = None
    tone_hint: Optional[str] = None
    memory_scope: Optional[str] = None


class ActiveWorkspaceUpdate(BaseModel):
    session_id: int
    workspace_id: str


@router.get("")
async def get_workspaces(
    session_id: Optional[int] = Query(default=None),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        ensure_default_workspace(conn, user_id=user.id)
        active_workspace_id = None
        if session_id is not None:
            try:
                active_workspace_id = get_session_active_workspace_id(
                    conn, user_id=user.id, session_id=session_id,
                )
            except ValueError:
                active_workspace_id = DEFAULT_WORKSPACE_ID
        return {
            "workspaces": [workspace.to_dict() for workspace in list_workspaces(conn, user_id=user.id)],
            "active_workspace_id": active_workspace_id,
        }

    return await memory.run_sync(_go)


@router.get("/{workspace_id}")
async def get_workspace_detail(
    workspace_id: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    workspace = await memory.run_sync(
        lambda conn: get_workspace(conn, user_id=user.id, workspace_id=workspace_id),
    )
    if workspace is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return workspace.to_dict()


@router.post("")
async def create_workspace_route(
    request: WorkspaceCreate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    workspace = await memory.run_sync(
        lambda conn: create_workspace(
            conn,
            user_id=user.id,
            name=request.name,
            persona_id=request.persona_id,
            default_mode=request.default_mode,
            attached_corpora=request.attached_corpora,
            tone_hint=request.tone_hint,
            memory_scope=request.memory_scope,
            workspace_id=request.id,
        ),
    )
    return workspace.to_dict()


@router.put("/{workspace_id}")
async def update_workspace_route(
    workspace_id: str,
    request: WorkspaceUpdate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    workspace = await memory.run_sync(
        lambda conn: update_workspace(
            conn,
            user_id=user.id,
            workspace_id=workspace_id,
            fields=request.model_dump(exclude_unset=True),
        ),
    )
    if workspace is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return workspace.to_dict()


@session_router.put("/session/active-workspace")
async def set_active_workspace_route(
    request: ActiveWorkspaceUpdate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    try:
        workspace = await memory.run_sync(
            lambda conn: set_session_active_workspace(
                conn,
                user_id=user.id,
                session_id=request.session_id,
                workspace_id=request.workspace_id,
            ),
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "session_not_found":
            raise HTTPException(status_code=404, detail=detail) from exc
        raise HTTPException(status_code=400, detail=detail) from exc
    return {"status": "ok", "workspace": workspace.to_dict()}


@router.delete("/{workspace_id}")
async def delete_workspace_route(
    workspace_id: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    try:
        deleted = await memory.run_sync(
            lambda conn: delete_workspace(conn, user_id=user.id, workspace_id=workspace_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return {"status": "ok"}
