"""JWT sign/verify + cookie helpers.

JWT secret resolution order:
  1. ``LOKIDOKI_JWT_SECRET`` env var (deploy-time override)
  2. ``app_secrets`` table row ``jwt_secret`` (auto-generated on first
     init via ``secrets.token_urlsafe(32)`` and persisted alongside
     the user data so a Pi reboot doesn't invalidate every cookie)
"""
from __future__ import annotations

import os
import secrets
import sqlite3
import time
from typing import Optional, Union, List, Any

import jwt

from lokidoki.core.memory_provider import MemoryProvider

COOKIE_NAME = "lokidoki_session"
TOKEN_TTL_S = 12 * 60 * 60  # 12h
ALGO = "HS256"


def _read_or_create_secret(conn: sqlite3.Connection) -> str:
    row = conn.execute(
        "SELECT value FROM app_secrets WHERE name = 'jwt_secret'"
    ).fetchone()
    if row:
        return str(row["value"])
    value = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO app_secrets (name, value) VALUES ('jwt_secret', ?)",
        (value,),
    )
    conn.commit()
    return value


async def get_secret(memory: MemoryProvider) -> str:
    env = os.environ.get("LOKIDOKI_JWT_SECRET")
    if env:
        return env
    return await memory.run_sync(_read_or_create_secret)


async def sign_token(memory: MemoryProvider, user_id: int) -> str:
    secret = await get_secret(memory)
    payload = {
        "sub": str(user_id),
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_S,
    }
    return jwt.encode(payload, secret, algorithm=ALGO)


async def verify_token(memory: MemoryProvider, token: str) -> Optional[int]:
    try:
        secret = await get_secret(memory)
        payload = jwt.decode(token, secret, algorithms=[ALGO])
        return int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        return None
