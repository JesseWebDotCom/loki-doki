import aiosqlite
from datetime import datetime, timezone


class SQLiteMemoryProvider:
    """Persistent memory store using SQLite.

    Replaces JSONMemoryProvider (Phase 1) with structured storage
    for messages, facts, and sentiment.
    """

    def __init__(self, db_path: str = "data/lokidoki.db"):
        self._db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        """Create tables if they don't exist."""
        self._db = await aiosqlite.connect(self._db_path)
        await self._db.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

            CREATE TABLE IF NOT EXISTS facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                fact TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS sentiment (
                session_id TEXT PRIMARY KEY,
                sentiment TEXT NOT NULL DEFAULT '',
                concern TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """)
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    # --- Messages ---

    async def add_message(self, session_id: str, role: str, content: str) -> None:
        await self._db.execute(
            "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, role, content),
        )
        await self._db.commit()

    async def get_messages(self, session_id: str, limit: int | None = None) -> list[dict]:
        if limit:
            cursor = await self._db.execute(
                "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (session_id, limit),
            )
            rows = await cursor.fetchall()
            rows.reverse()  # Return in chronological order
        else:
            cursor = await self._db.execute(
                "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
                (session_id,),
            )
            rows = await cursor.fetchall()
        return [{"role": r[0], "content": r[1], "created_at": r[2]} for r in rows]

    # --- Facts ---

    async def add_fact(self, category: str, fact: str) -> None:
        try:
            await self._db.execute(
                "INSERT OR IGNORE INTO facts (category, fact) VALUES (?, ?)",
                (category, fact),
            )
            await self._db.commit()
        except Exception:
            pass  # Deduplicate silently

    async def get_all_facts(self) -> list[dict]:
        cursor = await self._db.execute(
            "SELECT category, fact, created_at FROM facts ORDER BY id ASC"
        )
        rows = await cursor.fetchall()
        return [{"category": r[0], "fact": r[1], "created_at": r[2]} for r in rows]

    async def search_facts(self, query: str) -> list[dict]:
        cursor = await self._db.execute(
            "SELECT category, fact, created_at FROM facts WHERE fact LIKE ? COLLATE NOCASE",
            (f"%{query}%",),
        )
        rows = await cursor.fetchall()
        return [{"category": r[0], "fact": r[1], "created_at": r[2]} for r in rows]

    async def get_recent_facts(self, limit: int = 5) -> list[dict]:
        cursor = await self._db.execute(
            "SELECT category, fact, created_at FROM facts ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        rows.reverse()
        return [{"category": r[0], "fact": r[1], "created_at": r[2]} for r in rows]

    # --- Sentiment ---

    async def update_sentiment(self, session_id: str, sentiment: str, concern: str) -> None:
        await self._db.execute(
            "INSERT OR REPLACE INTO sentiment (session_id, sentiment, concern, updated_at) VALUES (?, ?, ?, datetime('now'))",
            (session_id, sentiment, concern),
        )
        await self._db.commit()

    async def get_sentiment(self, session_id: str) -> dict:
        cursor = await self._db.execute(
            "SELECT sentiment, concern FROM sentiment WHERE session_id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
        if row:
            return {"sentiment": row[0], "concern": row[1]}
        return {}

    # --- Session Management ---

    async def list_sessions(self) -> list[str]:
        cursor = await self._db.execute(
            "SELECT DISTINCT session_id FROM messages ORDER BY session_id"
        )
        rows = await cursor.fetchall()
        return [r[0] for r in rows]

    async def delete_session(self, session_id: str) -> None:
        await self._db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        await self._db.execute("DELETE FROM sentiment WHERE session_id = ?", (session_id,))
        await self._db.commit()
