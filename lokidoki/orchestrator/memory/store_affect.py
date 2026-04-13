"""Tier 6 — affective (affect_window) mixin for MemoryStore (M6)."""
from __future__ import annotations

import json
from typing import Any


class AffectMixin:
    """Tier 6 affect window and sentiment opt-out methods."""

    def write_affect_day(
        self, owner_user_id: int, *,
        character_id: str, day: str, sentiment_avg: float,
        notable_concerns: list[str] | None = None,
    ) -> None:
        """Upsert a single day's sentiment average into the affect window."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO affect_window("
                "    owner_user_id, character_id, day, sentiment_avg, notable_concerns"
                ") VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(owner_user_id, character_id, day)"
                " DO UPDATE SET sentiment_avg = excluded.sentiment_avg,"
                "              notable_concerns = excluded.notable_concerns",
                (owner_user_id, character_id, day, sentiment_avg,
                 json.dumps(notable_concerns) if notable_concerns else None),
            )

    def get_affect_window(
        self, owner_user_id: int, *,
        character_id: str, days: int = 14,
    ) -> list[dict[str, Any]]:
        """Return up to ``days`` most recent affect_window rows."""
        rows = self._conn.execute(
            "SELECT day, sentiment_avg, notable_concerns "
            "FROM affect_window "
            "WHERE owner_user_id = ? AND character_id = ? "
            "ORDER BY day DESC LIMIT ?",
            (owner_user_id, character_id, days),
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            concerns = None
            if row["notable_concerns"]:
                try:
                    concerns = json.loads(row["notable_concerns"])
                except (TypeError, ValueError):
                    concerns = None
            results.append({
                "day": row["day"],
                "sentiment_avg": row["sentiment_avg"],
                "notable_concerns": concerns,
            })
        return results

    def delete_affect_window(
        self, owner_user_id: int, *, character_id: str | None = None,
    ) -> int:
        """Wipe affect_window rows ("forget my mood"). Returns count deleted."""
        with self._lock:
            if character_id:
                cursor = self._conn.execute(
                    "DELETE FROM affect_window WHERE owner_user_id = ? AND character_id = ?",
                    (owner_user_id, character_id),
                )
            else:
                cursor = self._conn.execute(
                    "DELETE FROM affect_window WHERE owner_user_id = ?",
                    (owner_user_id,),
                )
            return cursor.rowcount

    def is_sentiment_opted_out(self, owner_user_id: int) -> bool:
        """Check if sentiment persistence is opted out."""
        profile = self.get_user_profile(owner_user_id)
        return bool(profile["telemetry"].get("sentiment_opted_out", False))

    def set_sentiment_opt_out(self, owner_user_id: int, opted_out: bool) -> None:
        """Toggle the sentiment persistence opt-out flag."""
        profile = self.get_user_profile(owner_user_id)
        telemetry = profile["telemetry"]
        telemetry["sentiment_opted_out"] = opted_out
        self.set_user_telemetry(owner_user_id, telemetry)
