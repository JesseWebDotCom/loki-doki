"""User CRUD on top of MemoryProvider.

All sync helpers take a sqlite3.Connection. Async wrappers go through
MemoryProvider.run_sync so they share the singleton lock.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

from lokidoki.auth import passwords
from lokidoki.core.memory_provider import MemoryProvider


@dataclass
class User:
    id: int
    username: str
    role: str
    status: str
    last_password_auth_at: int | None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


_USER_COLS = "id, username, role, status, last_password_auth_at"


def _row_to_user(row: sqlite3.Row | None) -> User | None:
    if row is None:
        return None
    return User(
        id=int(row["id"]),
        username=str(row["username"]),
        role=str(row["role"]),
        status=str(row["status"]),
        last_password_auth_at=(
            int(row["last_password_auth_at"])
            if row["last_password_auth_at"] is not None
            else None
        ),
    )


def _get_by_id(conn: sqlite3.Connection, user_id: int) -> User | None:
    row = conn.execute(
        f"SELECT {_USER_COLS} FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return _row_to_user(row)


def _get_by_username(conn: sqlite3.Connection, username: str) -> User | None:
    row = conn.execute(
        f"SELECT {_USER_COLS} FROM users WHERE username = ?", (username,)
    ).fetchone()
    return _row_to_user(row)


def _create(
    conn: sqlite3.Connection,
    *,
    username: str,
    pin_hash: str,
    role: str,
    password_hash: str | None,
) -> int:
    cur = conn.execute(
        "INSERT INTO users (username, pin_hash, password_hash, role, status) "
        "VALUES (?, ?, ?, ?, 'active')",
        (username, pin_hash, password_hash, role),
    )
    conn.commit()
    return int(cur.lastrowid)


async def get_user(memory: MemoryProvider, user_id: int) -> User | None:
    return await memory.run_sync(lambda c: _get_by_id(c, user_id))


async def get_user_by_username(memory: MemoryProvider, username: str) -> User | None:
    return await memory.run_sync(lambda c: _get_by_username(c, username))


async def get_pin_hash(memory: MemoryProvider, user_id: int) -> str | None:
    def _q(c: sqlite3.Connection):
        row = c.execute(
            "SELECT pin_hash FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return row["pin_hash"] if row else None
    return await memory.run_sync(_q)


async def get_password_hash(memory: MemoryProvider, user_id: int) -> str | None:
    def _q(c: sqlite3.Connection):
        row = c.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return row["password_hash"] if row else None
    return await memory.run_sync(_q)


async def create_user(
    memory: MemoryProvider,
    *,
    username: str,
    pin: str,
    role: str = "user",
    password: str | None = None,
) -> User:
    passwords.validate_pin(pin)
    if password is not None:
        passwords.validate_password(password)
    pin_h = passwords.hash_secret(pin)
    pwd_h = passwords.hash_secret(password) if password else None

    def _do(c: sqlite3.Connection):
        uid = _create(
            c, username=username, pin_hash=pin_h, role=role, password_hash=pwd_h
        )
        return _get_by_id(c, uid)

    return await memory.run_sync(_do)


async def list_users(memory: MemoryProvider) -> list[User]:
    def _q(c: sqlite3.Connection):
        rows = c.execute(
            f"SELECT {_USER_COLS} FROM users WHERE status != 'deleted' "
            "ORDER BY id ASC"
        ).fetchall()
        return [_row_to_user(r) for r in rows]
    return await memory.run_sync(_q)


async def set_status(memory: MemoryProvider, user_id: int, status: str) -> None:
    await memory.run_sync(
        lambda c: (c.execute(
            "UPDATE users SET status = ? WHERE id = ?", (status, user_id)
        ), c.commit())
    )


async def set_role(memory: MemoryProvider, user_id: int, role: str) -> None:
    await memory.run_sync(
        lambda c: (c.execute(
            "UPDATE users SET role = ? WHERE id = ?", (role, user_id)
        ), c.commit())
    )


async def reset_pin(memory: MemoryProvider, user_id: int, new_pin: str) -> None:
    passwords.validate_pin(new_pin)
    h = passwords.hash_secret(new_pin)
    await memory.run_sync(
        lambda c: (c.execute(
            "UPDATE users SET pin_hash = ? WHERE id = ?", (h, user_id)
        ), c.commit())
    )


async def stamp_password_auth(memory: MemoryProvider, user_id: int) -> None:
    ts = int(time.time())
    await memory.run_sync(
        lambda c: (c.execute(
            "UPDATE users SET last_password_auth_at = ? WHERE id = ?",
            (ts, user_id),
        ), c.commit())
    )
