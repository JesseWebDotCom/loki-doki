"""Skill account access helpers."""

from __future__ import annotations

import sqlite3

from . import storage as storage_module
from app.skills.types import AccountRecord


class AccountManager:
    """Resolve accounts for skill execution."""

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def list_accounts(self, skill_id: str) -> list[AccountRecord]:
        """Return all accounts for one skill."""
        return storage_module.list_skill_accounts(self._conn, skill_id)

    def resolve(self, skill_id: str, account_id: Optional[str] = None) -> Optional[AccountRecord]:
        """Resolve an account by explicit id or default account."""
        if account_id:
            return storage_module.get_skill_account(self._conn, skill_id, account_id)
        accounts = self.list_accounts(skill_id)
        for account in accounts:
            if account.enabled and account.is_default:
                return account
        for account in accounts:
            if account.enabled:
                return account
        return None
