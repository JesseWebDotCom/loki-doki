"""Per-user sentiment + session deletion helpers.

Bound onto MemoryProvider as methods at import time so the provider
file stays under the 250-line cap from CLAUDE.md.
"""
from __future__ import annotations

import json

from lokidoki.core.memory_provider import MemoryProvider


async def get_sentiment(self: MemoryProvider, user_id: int) -> dict:
    def _q(c):
        row = c.execute(
            "SELECT sentiment FROM user_sentiment WHERE owner_user_id = ?",
            (user_id,),
        ).fetchone()
        return row["sentiment"] if row else None

    raw = await self.run_sync(_q)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


async def set_sentiment(self: MemoryProvider, user_id: int, sentiment: dict) -> None:
    payload = json.dumps(sentiment)

    def _do(c):
        c.execute(
            "INSERT INTO user_sentiment (owner_user_id, sentiment) VALUES (?, ?) "
            "ON CONFLICT(owner_user_id) DO UPDATE SET "
            "sentiment = excluded.sentiment, updated_at = datetime('now')",
            (user_id, payload),
        )
        c.commit()

    await self.run_sync(_do)


async def delete_session(self: MemoryProvider, user_id: int, session_id: int) -> bool:
    def _do(c):
        cur = c.execute(
            "DELETE FROM sessions WHERE id = ? AND owner_user_id = ?",
            (session_id, user_id),
        )
        c.commit()
        return cur.rowcount > 0

    return await self.run_sync(_do)


async def clear_user_chat(self: MemoryProvider, user_id: int) -> None:
    def _do(c):
        c.execute("DELETE FROM sessions WHERE owner_user_id = ?", (user_id,))
        c.commit()

    await self.run_sync(_do)


async def append_sentiment_log(
    self: MemoryProvider,
    user_id: int,
    *,
    sentiment: str,
    concern: str = "",
    source_message_id: int | None = None,
) -> None:
    """Append one row to the per-turn sentiment time series."""
    if not sentiment or not sentiment.strip():
        return

    def _do(c):
        c.execute(
            "INSERT INTO sentiment_log (owner_user_id, sentiment, concern, source_message_id) "
            "VALUES (?, ?, ?, ?)",
            (user_id, sentiment.strip().lower(), concern or "", source_message_id),
        )
        c.commit()

    await self.run_sync(_do)


async def get_recent_sentiment(
    self: MemoryProvider, user_id: int, *, limit: int = 5
) -> list[dict]:
    """Return the user's last N sentiment_log rows, newest first.

    Used by the synthesis prompt to inject an emotional ARC into the
    tone block — a single off-mood turn isn't enough to act on, but
    "the user has been frustrated for three turns" is.
    """
    def _q(c):
        rows = c.execute(
            "SELECT sentiment, concern, created_at FROM sentiment_log "
            "WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    return await self.run_sync(_q)


MemoryProvider.get_sentiment = get_sentiment           # type: ignore[attr-defined]
MemoryProvider.set_sentiment = set_sentiment           # type: ignore[attr-defined]
MemoryProvider.delete_session = delete_session         # type: ignore[attr-defined]
MemoryProvider.clear_user_chat = clear_user_chat       # type: ignore[attr-defined]
MemoryProvider.append_sentiment_log = append_sentiment_log     # type: ignore[attr-defined]
MemoryProvider.get_recent_sentiment = get_recent_sentiment     # type: ignore[attr-defined]
