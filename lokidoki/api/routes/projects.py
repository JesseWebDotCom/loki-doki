from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    prompt: str = ""


class ProjectUpdate(BaseModel):
    name: str
    description: str
    prompt: str


@router.post("")
async def create_project(
    request: ProjectCreate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    project_id = await memory.create_project(
        user.id, request.name, request.description, request.prompt
    )
    return {"id": project_id, "status": "ok"}


@router.get("")
async def list_projects(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    projects = await memory.list_projects(user.id)
    return {"projects": projects}


@router.get("/{project_id}")
async def get_project(
    project_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    project = await memory.get_project(user.id, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project_not_found")
    return project


@router.patch("/{project_id}")
async def update_project(
    project_id: int,
    request: ProjectUpdate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    updated = await memory.update_project(
        user.id, project_id, request.name, request.description, request.prompt
    )
    if not updated:
        raise HTTPException(status_code=404, detail="project_not_found")
    return {"status": "ok"}


@router.delete("/{project_id}")
async def delete_project(
    project_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    deleted = await memory.delete_project(user.id, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="project_not_found")
    return {"status": "ok"}
