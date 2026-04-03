"""SQLite persistence for users and settings."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from app.chats import store as chat_store
from app.subsystems.memory import db as memory_db
DEFAULT_ACCOUNT_NAME = "Primary Household"
DEFAULT_ACCOUNT_ID = "default-account"
DEFAULT_ACCOUNT_POLICY_EXAMPLE = (
    "Never claim you completed a real-world action unless a tool or skill confirmed it. "
    "Keep household-assistant responses concise, practical, and honest about uncertainty."
)
DEFAULT_ADMIN_PROMPT_EXAMPLE = (
    "Speak to this user in a calm, reassuring tone. Put the most important next step in the first sentence "
    "when giving reminders or plans."
)
DEFAULT_USER_PROMPT_EXAMPLE = (
    "Call me Jesse. Keep answers short unless I ask for more detail. If you suggest a plan, include one simple next step."
)
DEFAULT_CHARACTER_CUSTOM_PROMPT_EXAMPLE = (
    "For this character, be a little more playful and upbeat, but stay grounded, practical, and directly helpful."
)


def connect(database_path: Path) -> sqlite3.Connection:
    """Return a SQLite connection with row access enabled."""
    conn = sqlite3.connect(database_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def connection_scope(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Yield one SQLite connection and always close it."""
    conn = connect(database_path)
    try:
        yield conn
    finally:
        conn.close()


def initialize_database(conn: sqlite3.Connection) -> None:
    """Create required application tables and apply lightweight migrations."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            default_character_id TEXT NOT NULL DEFAULT 'lokidoki',
            character_feature_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            account_id TEXT,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            bio TEXT NOT NULL DEFAULT '',
            relationships_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            profile TEXT NOT NULL,
            app_name TEXT NOT NULL,
            allow_signup INTEGER NOT NULL DEFAULT 0,
            auto_update_skills INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            PRIMARY KEY (user_id, key),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS account_prompt_policy (
            account_id TEXT PRIMARY KEY,
            core_safety_prompt TEXT NOT NULL DEFAULT '',
            account_policy_prompt TEXT NOT NULL DEFAULT '',
            proactive_chatter_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS care_profiles (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            tone TEXT NOT NULL DEFAULT '',
            vocabulary TEXT NOT NULL DEFAULT 'standard',
            sentence_length TEXT NOT NULL DEFAULT 'medium',
            response_style TEXT NOT NULL DEFAULT 'chat_balanced',
            blocked_topics_json TEXT NOT NULL DEFAULT '[]',
            safe_messaging INTEGER NOT NULL DEFAULT 1,
            max_response_tokens INTEGER NOT NULL DEFAULT 160,
            builtin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS character_catalog (
            character_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            source TEXT NOT NULL,
            system_prompt TEXT NOT NULL,
            teaser TEXT NOT NULL DEFAULT '',
            phonetic_spelling TEXT NOT NULL DEFAULT '',
            identity_key TEXT NOT NULL DEFAULT '',
            domain TEXT NOT NULL DEFAULT '',
            behavior_style TEXT NOT NULL DEFAULT '',
            voice_model TEXT NOT NULL DEFAULT '',
            default_voice TEXT NOT NULL DEFAULT '',
            default_voice_download_url TEXT NOT NULL DEFAULT '',
            default_voice_config_download_url TEXT NOT NULL DEFAULT '',
            default_voice_source_name TEXT NOT NULL DEFAULT '',
            default_voice_config_source_name TEXT NOT NULL DEFAULT '',
            wakeword_model_id TEXT NOT NULL DEFAULT '',
            wakeword_download_url TEXT NOT NULL DEFAULT '',
            wakeword_source_name TEXT NOT NULL DEFAULT '',
            capabilities_json TEXT NOT NULL DEFAULT '{}',
            character_editor_json TEXT NOT NULL DEFAULT '{}',
            logo TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            builtin INTEGER NOT NULL DEFAULT 0,
            path TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_character_settings (
            user_id TEXT PRIMARY KEY,
            care_profile_id TEXT NOT NULL DEFAULT 'standard',
            character_enabled INTEGER NOT NULL DEFAULT 1,
            active_character_id TEXT,
            user_prompt TEXT NOT NULL DEFAULT '',
            base_prompt_hash TEXT NOT NULL DEFAULT '',
            compiled_prompt_hash TEXT NOT NULL DEFAULT '',
            compiled_base_prompt TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (care_profile_id) REFERENCES care_profiles(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS user_prompt_overrides (
            user_id TEXT PRIMARY KEY,
            admin_prompt TEXT NOT NULL DEFAULT '',
            blocked_topics_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_character_customizations (
            user_id TEXT NOT NULL,
            character_id TEXT NOT NULL,
            custom_prompt TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, character_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    _ensure_user_column(conn, "account_id", "TEXT")
    _ensure_account_prompt_policy_column(conn, "proactive_chatter_enabled", "INTEGER NOT NULL DEFAULT 0")
    _ensure_character_settings_column(conn, "compiled_prompt_hash", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_settings_column(conn, "compiled_base_prompt", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_settings_column(conn, "assigned_character_id", "TEXT")
    _ensure_character_settings_column(conn, "can_select_character", "INTEGER NOT NULL DEFAULT 1")
    _ensure_character_catalog_column(conn, "logo", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "teaser", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "phonetic_spelling", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "identity_key", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "domain", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "behavior_style", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "voice_model", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "default_voice_download_url", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "default_voice_config_download_url", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "default_voice_source_name", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "default_voice_config_source_name", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "wakeword_model_id", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "wakeword_download_url", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "wakeword_source_name", "TEXT NOT NULL DEFAULT ''")
    _ensure_character_catalog_column(conn, "character_editor_json", "TEXT NOT NULL DEFAULT '{}'")
    _ensure_settings_column(conn, "auto_update_skills", "INTEGER NOT NULL DEFAULT 0")
    _ensure_care_profiles_column(conn, "response_style", "TEXT NOT NULL DEFAULT 'chat_balanced'")
    _ensure_default_account(conn)
    _ensure_users_have_account(conn)
    _ensure_account_prompt_policy(conn)
    _ensure_builtin_care_profiles(conn)
    _ensure_user_character_rows(conn)
    _seed_example_prompt_content(conn)
    chat_store.initialize_chat_tables(conn)
    memory_db.initialize_memory_tables(conn)
    conn.commit()


def _ensure_user_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add one column to users if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(users)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE users ADD COLUMN {column_name} {ddl}")


def _ensure_settings_column(
    conn: sqlite3.Connection, column_name: str, ddl: str
) -> None:
    """Add one column to settings if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(settings)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE settings ADD COLUMN {column_name} {ddl}")


def _ensure_account_prompt_policy_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add one column to account_prompt_policy if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(account_prompt_policy)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE account_prompt_policy ADD COLUMN {column_name} {ddl}")


def _ensure_character_settings_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add one column to user_character_settings if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(user_character_settings)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE user_character_settings ADD COLUMN {column_name} {ddl}")


def _ensure_character_catalog_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add a missing column to the character_catalog table."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(character_catalog)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE character_catalog ADD COLUMN {column_name} {ddl}")


def _ensure_care_profiles_column(conn: sqlite3.Connection, column_name: str, ddl: str) -> None:
    """Add one column to care_profiles if it is missing."""
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(care_profiles)").fetchall()
    }
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE care_profiles ADD COLUMN {column_name} {ddl}")


def _ensure_default_account(conn: sqlite3.Connection) -> None:
    """Create the default household account when missing."""
    conn.execute(
        """
        INSERT INTO accounts (id, name, default_character_id, character_feature_enabled)
        VALUES (?, ?, 'lokidoki', 1)
        ON CONFLICT(id) DO NOTHING
        """,
        (DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_NAME),
    )


def _ensure_users_have_account(conn: sqlite3.Connection) -> None:
    """Attach every existing user to the default account."""
    conn.execute(
        "UPDATE users SET account_id = ? WHERE account_id IS NULL OR TRIM(account_id) = ''",
        (DEFAULT_ACCOUNT_ID,),
    )


def _ensure_account_prompt_policy(conn: sqlite3.Connection) -> None:
    """Seed the default account prompt policy row."""
    conn.execute(
        """
        INSERT INTO account_prompt_policy (account_id, core_safety_prompt, account_policy_prompt)
        VALUES (?, '', '')
        ON CONFLICT(account_id) DO NOTHING
        """,
        (DEFAULT_ACCOUNT_ID,),
    )


def _ensure_builtin_care_profiles(conn: sqlite3.Connection) -> None:
    """Seed built-in care profiles used by the character orchestration layer."""
    profiles = (
        (
            "child",
            "Child (Under 13)",
            "warm, playful, encouraging",
            "simple",
            "short",
            "chat_balanced",
            json.dumps(["violence", "adult_content", "politics"]),
            1,
            150,
        ),
        (
            "teen",
            "Teen",
            "friendly, direct, encouraging",
            "standard",
            "medium",
            "chat_balanced",
            json.dumps(["adult_content"]),
            1,
            180,
        ),
        (
            "standard",
            "Adult Standard",
            "helpful, balanced, clear",
            "standard",
            "medium",
            "chat_balanced",
            json.dumps([]),
            1,
            220,
        ),
        (
            "clinical",
            "Clinical",
            "precise, calm, neutral",
            "advanced",
            "medium",
            "chat_detailed",
            json.dumps([]),
            1,
            180,
        ),
        (
            "expert",
            "Expert",
            "concise, technical, confident",
            "advanced",
            "short",
            "chat_balanced",
            json.dumps([]),
            0,
            220,
        ),
    )
    conn.executemany(
        """
        INSERT INTO care_profiles (
            id, label, tone, vocabulary, sentence_length, response_style, blocked_topics_json,
            safe_messaging, max_response_tokens, builtin
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            tone = excluded.tone,
            vocabulary = excluded.vocabulary,
            sentence_length = excluded.sentence_length,
            response_style = excluded.response_style,
            blocked_topics_json = excluded.blocked_topics_json,
            safe_messaging = excluded.safe_messaging,
            max_response_tokens = excluded.max_response_tokens,
            builtin = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        profiles,
    )


def _ensure_user_character_rows(conn: sqlite3.Connection) -> None:
    """Seed default character settings rows for all existing users."""
    user_ids = [str(row["id"]) for row in conn.execute("SELECT id FROM users").fetchall()]
    conn.executemany(
        """
        INSERT INTO user_character_settings (
            user_id, care_profile_id, character_enabled, active_character_id, user_prompt, base_prompt_hash,
            compiled_prompt_hash, compiled_base_prompt
        )
        VALUES (?, 'standard', 1, 'lokidoki', '', '', '', '')
        ON CONFLICT(user_id) DO NOTHING
        """,
        [(user_id,) for user_id in user_ids],
    )
    conn.executemany(
        """
        INSERT INTO user_prompt_overrides (user_id, admin_prompt, blocked_topics_json)
        VALUES (?, '', '[]')
        ON CONFLICT(user_id) DO NOTHING
        """,
        [(user_id,) for user_id in user_ids],
    )


def _seed_example_prompt_content(conn: sqlite3.Connection) -> None:
    """Seed example prompt content for blank prompt fields only."""
    conn.execute(
        """
        UPDATE account_prompt_policy
        SET account_policy_prompt = ?
        WHERE account_id = ? AND TRIM(account_policy_prompt) = ''
        """,
        (DEFAULT_ACCOUNT_POLICY_EXAMPLE, DEFAULT_ACCOUNT_ID),
    )
    conn.execute(
        """
        UPDATE user_character_settings
        SET user_prompt = ?
        WHERE TRIM(user_prompt) = ''
        """,
        (DEFAULT_USER_PROMPT_EXAMPLE,),
    )
    conn.execute(
        """
        UPDATE user_prompt_overrides
        SET admin_prompt = ?
        WHERE TRIM(admin_prompt) = ''
        """,
        (DEFAULT_ADMIN_PROMPT_EXAMPLE,),
    )
    user_ids = [str(row["id"]) for row in conn.execute("SELECT id FROM users").fetchall()]
    conn.executemany(
        """
        INSERT INTO user_character_customizations (user_id, character_id, custom_prompt, updated_at)
        VALUES (?, 'lokidoki', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, character_id) DO UPDATE SET
            custom_prompt = CASE
                WHEN TRIM(user_character_customizations.custom_prompt) = '' THEN excluded.custom_prompt
                ELSE user_character_customizations.custom_prompt
            END,
            updated_at = CASE
                WHEN TRIM(user_character_customizations.custom_prompt) = '' THEN CURRENT_TIMESTAMP
                ELSE user_character_customizations.updated_at
            END
        """,
        [(user_id, DEFAULT_CHARACTER_CUSTOM_PROMPT_EXAMPLE) for user_id in user_ids],
    )


def ensure_admin_user(
    conn: sqlite3.Connection,
    username: str,
    password_hash: str,
    display_name: str,
) -> None:
    """Create the bootstrap admin user if it does not already exist."""
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    if row:
        return
    conn.execute(
        """
        INSERT INTO users (id, account_id, username, display_name, password_hash, bio, relationships_json)
        VALUES (?, ?, ?, ?, ?, '', ?)
        """,
        (str(uuid4()), DEFAULT_ACCOUNT_ID, username, display_name, password_hash, json.dumps({})),
    )
    _ensure_user_character_rows(conn)
    conn.commit()


def save_app_settings(
    conn: sqlite3.Connection,
    profile: str,
    app_name: str,
    allow_signup: bool,
    auto_update_skills: bool = False,
) -> None:
    """Persist global application settings."""
    conn.execute(
        """
        INSERT INTO settings (id, profile, app_name, allow_signup, auto_update_skills)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            profile = excluded.profile,
            app_name = excluded.app_name,
            allow_signup = excluded.allow_signup,
            auto_update_skills = excluded.auto_update_skills
        """,
        (profile, app_name, int(allow_signup), int(auto_update_skills)),
    )
    conn.commit()


def get_app_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return global application settings."""
    row = conn.execute(
        "SELECT profile, app_name, allow_signup, auto_update_skills FROM settings WHERE id = 1"
    ).fetchone()
    if not row:
        return {"profile": "mac", "app_name": "LokiDoki", "allow_signup": False, "auto_update_skills": False}
    return {
        "profile": row["profile"],
        "app_name": row["app_name"],
        "allow_signup": bool(row["allow_signup"]),
        "auto_update_skills": bool(row["auto_update_skills"]),
    }


def get_user_by_username(
    conn: sqlite3.Connection,
    username: str,
) -> Optional[dict[str, Any]]:
    """Return a user by username."""
    row = conn.execute(
        """
        SELECT id, username, display_name, password_hash, bio, relationships_json
        , account_id
        FROM users WHERE username = ?
        """,
        (username,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def get_user_by_id(
    conn: sqlite3.Connection,
    user_id: str,
) -> Optional[dict[str, Any]]:
    """Return a user by id."""
    row = conn.execute(
        """
        SELECT id, username, display_name, password_hash, bio, relationships_json
        , account_id
        FROM users WHERE id = ?
        """,
        (user_id,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def create_user(
    conn: sqlite3.Connection,
    username: str,
    display_name: str,
    password_hash: str,
) -> dict[str, Any]:
    """Create a new local user."""
    user = {
        "id": str(uuid4()),
        "account_id": DEFAULT_ACCOUNT_ID,
        "username": username,
        "display_name": display_name,
        "password_hash": password_hash,
        "bio": "",
        "relationships_json": json.dumps({}),
    }
    conn.execute(
        """
        INSERT INTO users (id, account_id, username, display_name, password_hash, bio, relationships_json)
        VALUES (:id, :account_id, :username, :display_name, :password_hash, :bio, :relationships_json)
        """,
        user,
    )
    _ensure_user_character_rows(conn)
    conn.commit()
    return user


def list_users(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return all local users ordered by creation time."""
    rows = conn.execute(
        """
        SELECT id, account_id, username, display_name, password_hash, bio, relationships_json, created_at
        FROM users
        ORDER BY created_at ASC, rowid ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def update_user_password(
    conn: sqlite3.Connection,
    user_id: str,
    password_hash: str,
) -> None:
    """Update one local user's password hash."""
    conn.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (password_hash, user_id),
    )
    conn.commit()


def update_user_profile(
    conn: sqlite3.Connection,
    user_id: str,
    display_name: str,
) -> None:
    """Update one local user's profile fields."""
    conn.execute(
        "UPDATE users SET display_name = ? WHERE id = ?",
        (display_name, user_id),
    )
    conn.commit()


def delete_user(
    conn: sqlite3.Connection,
    user_id: str,
) -> None:
    """Delete one local user."""
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()


def get_user_admin_flag(conn: sqlite3.Connection, user_id: str) -> bool:
    """Return whether one user has an explicit admin flag."""
    return bool(get_user_setting(conn, user_id, "role_admin", False))


def set_user_admin_flag(
    conn: sqlite3.Connection,
    user_id: str,
    is_admin: bool,
) -> None:
    """Persist one user's explicit admin flag."""
    set_user_setting(conn, user_id, "role_admin", bool(is_admin))


def get_user_setting(
    conn: sqlite3.Connection,
    user_id: str,
    key: str,
    default: Any,
) -> Any:
    """Return a JSON user setting with fallback."""
    row = conn.execute(
        "SELECT value_json FROM user_settings WHERE user_id = ? AND key = ?",
        (user_id, key),
    ).fetchone()
    if not row:
        return default
    return json.loads(row["value_json"])


def set_user_setting(
    conn: sqlite3.Connection,
    user_id: str,
    key: str,
    value: Any,
) -> None:
    """Persist a JSON user setting."""
    conn.execute(
        """
        INSERT INTO user_settings (user_id, key, value_json)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json
        """,
        (user_id, key, json.dumps(value)),
    )
    conn.commit()
