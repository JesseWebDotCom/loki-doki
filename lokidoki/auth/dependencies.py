"""FastAPI dependencies: current_user, require_admin."""
from __future__ import annotations

import time

from fastapi import Cookie, Depends, HTTPException, status

from lokidoki.auth import tokens, users as users_mod
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.memory_singleton import get_memory_provider

ADMIN_FRESHNESS_S = 15 * 60  # 15 minutes


async def get_memory() -> MemoryProvider:
    return await get_memory_provider()


async def current_user(
    lokidoki_session: str | None = Cookie(default=None),
    memory: MemoryProvider = Depends(get_memory),
) -> User:
    # If no users exist, the bootstrap gate middleware should have
    # already short-circuited the request. Defense in depth: 409 here.
    if await memory.count_users() == 0:
        raise HTTPException(status_code=409, detail="needs_bootstrap")
    if not lokidoki_session:
        raise HTTPException(status_code=401, detail="not_authenticated")
    uid = await tokens.verify_token(memory, lokidoki_session)
    if uid is None:
        raise HTTPException(status_code=401, detail="invalid_token")
    user = await users_mod.get_user(memory, uid)
    if user is None or user.status == "deleted":
        raise HTTPException(status_code=401, detail="user_missing")
    if user.status == "disabled":
        raise HTTPException(status_code=403, detail="user_disabled")
    return user


async def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin_required")
    if user.last_password_auth_at is None:
        raise HTTPException(status_code=403, detail="password_challenge_required")
    if int(time.time()) - user.last_password_auth_at > ADMIN_FRESHNESS_S:
        raise HTTPException(status_code=403, detail="password_challenge_expired")
    return user
