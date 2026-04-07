"""Auth routes: bootstrap, login, logout, me, challenge-admin."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from lokidoki.auth import passwords, tokens, users as users_mod
from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.tokens import COOKIE_NAME, TOKEN_TTL_S
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


class BootstrapRequest(BaseModel):
    username: str
    pin: str
    password: str


class LoginRequest(BaseModel):
    username: str
    pin: str


class ChallengeRequest(BaseModel):
    password: str


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=TOKEN_TTL_S,
        httponly=True,
        samesite="lax",
        secure=False,
    )


@router.post("/bootstrap")
async def bootstrap(
    body: BootstrapRequest,
    response: Response,
    memory: MemoryProvider = Depends(get_memory),
):
    if await memory.count_users() > 0:
        raise HTTPException(status_code=409, detail="already_bootstrapped")
    try:
        passwords.validate_pin(body.pin)
        passwords.validate_password(body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="username_required")

    user = await users_mod.create_user(
        memory,
        username=body.username.strip(),
        pin=body.pin,
        role="admin",
        password=body.password,
    )
    await users_mod.stamp_password_auth(memory, user.id)
    token = await tokens.sign_token(memory, user.id)
    _set_cookie(response, token)
    return {
        "id": user.id,
        "username": user.username,
        "role": "admin",
    }


@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    memory: MemoryProvider = Depends(get_memory),
):
    user = await users_mod.get_user_by_username(memory, body.username.strip())
    if user is None or user.status == "deleted":
        raise HTTPException(status_code=401, detail="invalid_credentials")
    if user.status == "disabled":
        raise HTTPException(status_code=403, detail="user_disabled")

    allowed = await passwords.check_rate_limit(user.id)
    if not allowed:
        raise HTTPException(status_code=429, detail="rate_limited")

    pin_hash = await users_mod.get_pin_hash(memory, user.id)
    if not passwords.verify_secret(body.pin, pin_hash):
        raise HTTPException(status_code=401, detail="invalid_credentials")

    token = await tokens.sign_token(memory, user.id)
    _set_cookie(response, token)
    return {"id": user.id, "username": user.username, "role": user.role}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
async def me(
    request: Request,
    memory: MemoryProvider = Depends(get_memory),
):
    """200 with user, 401 if no/invalid cookie, 409 if no users exist."""
    if await memory.count_users() == 0:
        raise HTTPException(status_code=409, detail="needs_bootstrap")
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="not_authenticated")
    uid = await tokens.verify_token(memory, token)
    if uid is None:
        raise HTTPException(status_code=401, detail="invalid_token")
    user = await users_mod.get_user(memory, uid)
    if user is None or user.status == "deleted":
        raise HTTPException(status_code=401, detail="user_missing")
    if user.status == "disabled":
        raise HTTPException(status_code=403, detail="user_disabled")
    import time as _t
    fresh = (
        user.last_password_auth_at is not None
        and _t.time() - user.last_password_auth_at < 15 * 60
    )
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "admin_fresh": bool(fresh),
    }


@router.post("/challenge-admin")
async def challenge_admin(
    body: ChallengeRequest,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin_required")
    pwd_hash = await users_mod.get_password_hash(memory, user.id)
    allowed = await passwords.check_rate_limit(user.id)
    if not allowed:
        raise HTTPException(status_code=429, detail="rate_limited")
    if not passwords.verify_secret(body.password, pwd_hash):
        raise HTTPException(status_code=401, detail="invalid_password")
    await users_mod.stamp_password_auth(memory, user.id)
    return {"ok": True}
