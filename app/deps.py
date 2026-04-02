"""FastAPI dependencies and global configuration."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Optional

from fastapi import Header, HTTPException

from app import db
from app.config import get_app_config, load_bootstrap_config
from app.debug import is_admin_user
from app.security import decode_access_token
from app.subsystems.character import character_service
from app.skills import skill_service

APP_CONFIG = get_app_config()
DB_INIT_LOCK = threading.Lock()
_DB_READY = False


def ensure_database_ready() -> None:
    """Initialize the application database once for this process."""
    global _DB_READY
    if _DB_READY:
        return
    with DB_INIT_LOCK:
        if _DB_READY:
            return
        with db.connection_scope(APP_CONFIG.database_path) as connection:
            db.initialize_database(connection)
            skill_service.initialize(connection, APP_CONFIG)
            character_service.initialize(connection, APP_CONFIG)
            bootstrap_config = load_bootstrap_config(APP_CONFIG.bootstrap_config_path)
            if bootstrap_config:
                admin = bootstrap_config.get("admin", {})
                db.ensure_admin_user(
                    connection,
                    username=admin.get("username", "admin"),
                    password_hash=admin.get("password_hash", ""),
                    display_name=bootstrap_config.get("app_name", "LokiDoki Admin"),
                )
                db.save_app_settings(
                    connection,
                    profile=bootstrap_config.get("profile", "mac"),
                    app_name=bootstrap_config.get("app_name", "LokiDoki"),
                    allow_signup=bool(bootstrap_config.get("allow_signup", False)),
                )
        _DB_READY = True


@contextmanager
def connection_scope() -> Iterator[sqlite3.Connection]:
    """Yield one request-scoped SQLite connection."""
    ensure_database_ready()
    with db.connection_scope(APP_CONFIG.database_path) as connection:
        yield connection


def get_current_user(authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    """Resolve the authenticated user from the Authorization header."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token.")
    token = authorization.split(" ", 1)[1]
    try:
        payload = decode_access_token(token, APP_CONFIG.jwt_secret)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid token.") from exc
    with connection_scope() as connection:
        user = db.get_user_by_id(connection, str(payload["sub"]))
        if user:
            user = {**user, "is_admin": db.get_user_admin_flag(connection, user["id"])}
    if not user:
        raise HTTPException(status_code=401, detail="Unknown user.")
    return user


def enforce_admin(current_user: dict[str, Any]) -> None:
    """Require an admin user for the active request."""
    if not is_admin_user(current_user, APP_CONFIG):
        raise HTTPException(status_code=403, detail="Admin access is required.")
