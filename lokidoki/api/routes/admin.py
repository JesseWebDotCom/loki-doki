"""Admin routes — user management. Guarded by require_admin."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lokidoki.auth import users as users_mod
from lokidoki.auth.dependencies import get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


class CreateUserRequest(BaseModel):
    username: str
    pin: str
    role: str = "user"


class ResetPinRequest(BaseModel):
    new_pin: str


def _serialize(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "role": u.role,
        "status": u.status,
    }


@router.get("/users")
async def list_users(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    users = await users_mod.list_users(memory)
    return {"users": [_serialize(u) for u in users]}


@router.post("/users")
async def create_user(
    body: CreateUserRequest,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="invalid_role")
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="username_required")
    existing = await users_mod.get_user_by_username(memory, body.username.strip())
    if existing is not None and existing.status != "deleted":
        raise HTTPException(status_code=409, detail="username_taken")
    try:
        u = await users_mod.create_user(
            memory,
            username=body.username.strip(),
            pin=body.pin,
            role=body.role,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _serialize(u)


async def _get_target(memory: MemoryProvider, user_id: int) -> User:
    u = await users_mod.get_user(memory, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    return u


@router.post("/users/{user_id}/disable")
async def disable_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_disable_self")
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "disabled")
    return {"ok": True}


@router.post("/users/{user_id}/enable")
async def enable_user(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "active")
    return {"ok": True}


@router.post("/users/{user_id}/delete")
async def delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_delete_self")
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "deleted")
    return {"ok": True}


@router.post("/users/{user_id}/promote")
async def promote_user(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    await users_mod.set_role(memory, user_id, "admin")
    return {"ok": True}


@router.post("/users/{user_id}/demote")
async def demote_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_demote_self")
    await _get_target(memory, user_id)
    await users_mod.set_role(memory, user_id, "user")
    return {"ok": True}


@router.post("/users/{user_id}/reset-pin")
async def reset_pin(
    user_id: int,
    body: ResetPinRequest,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    try:
        await users_mod.reset_pin(memory, user_id, body.new_pin)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}
