"""Tier 7 — procedural (behavior events + user profile) mixin for MemoryStore (M5)."""
from __future__ import annotations

import json
from typing import Any

from lokidoki.orchestrator.memory.store_helpers import _now


class BehaviorMixin:
    """Tier 7 behavior event and user profile methods."""

    def write_behavior_event(
        self, owner_user_id: int, *,
        event_type: str, payload: dict[str, Any] | None = None,
    ) -> int:
        """Append a behavior event row. Returns the new id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO behavior_events(owner_user_id, event_type, payload) "
                "VALUES (?, ?, ?)",
                (owner_user_id, event_type,
                 json.dumps(payload) if payload else None),
            )
            return int(cursor.lastrowid)

    def get_behavior_events(
        self, owner_user_id: int, *,
        since: str | None = None, event_type: str | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return behavior events, newest first."""
        sql = "SELECT * FROM behavior_events WHERE owner_user_id = ?"
        params: list[Any] = [owner_user_id]
        if since:
            sql += " AND at >= ?"
            params.append(since)
        if event_type:
            sql += " AND event_type = ?"
            params.append(event_type)
        sql += " ORDER BY at DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def delete_behavior_events_before(
        self, owner_user_id: int, *, before: str,
    ) -> int:
        """Delete events older than ``before``. Returns count deleted."""
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM behavior_events WHERE owner_user_id = ? AND at < ?",
                (owner_user_id, before),
            )
            return cursor.rowcount

    def get_user_profile(self, owner_user_id: int) -> dict[str, Any]:
        """Return the user profile with ``style`` and ``telemetry`` keys."""
        row = self._conn.execute(
            "SELECT style, telemetry, updated_at FROM user_profile "
            "WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        if row is None:
            return {"style": {}, "telemetry": {}, "updated_at": None}
        style = {}
        telemetry = {}
        try:
            style = json.loads(row["style"] or "{}")
        except (TypeError, ValueError):
            pass
        try:
            telemetry = json.loads(row["telemetry"] or "{}")
        except (TypeError, ValueError):
            pass
        return {
            "style": style if isinstance(style, dict) else {},
            "telemetry": telemetry if isinstance(telemetry, dict) else {},
            "updated_at": row["updated_at"],
        }

    def set_user_style(self, owner_user_id: int, style: dict[str, Any]) -> None:
        """Upsert the prompt-safe style (Tier 7a) on the user profile."""
        with self._lock:
            existing = self._conn.execute(
                "SELECT owner_user_id FROM user_profile WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            now = _now()
            if existing:
                self._conn.execute(
                    "UPDATE user_profile SET style = ?, updated_at = ? "
                    "WHERE owner_user_id = ?",
                    (json.dumps(style), now, owner_user_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO user_profile(owner_user_id, style, updated_at) "
                    "VALUES (?, ?, ?)",
                    (owner_user_id, json.dumps(style), now),
                )

    def set_user_telemetry(
        self, owner_user_id: int, telemetry: dict[str, Any],
    ) -> None:
        """Upsert the prompt-forbidden telemetry (Tier 7b)."""
        with self._lock:
            existing = self._conn.execute(
                "SELECT owner_user_id FROM user_profile WHERE owner_user_id = ?",
                (owner_user_id,),
            ).fetchone()
            now = _now()
            if existing:
                self._conn.execute(
                    "UPDATE user_profile SET telemetry = ?, updated_at = ? "
                    "WHERE owner_user_id = ?",
                    (json.dumps(telemetry), now, owner_user_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO user_profile(owner_user_id, telemetry, updated_at) "
                    "VALUES (?, ?, ?)",
                    (owner_user_id, json.dumps(telemetry), now),
                )

    def get_behavior_event_count(self, owner_user_id: int) -> int:
        """Return total behavior event count for an owner."""
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM behavior_events WHERE owner_user_id = ?",
            (owner_user_id,),
        ).fetchone()
        return int(row["cnt"]) if row else 0

    def is_telemetry_opted_out(self, owner_user_id: int) -> bool:
        """Check if telemetry collection is opted out."""
        profile = self.get_user_profile(owner_user_id)
        return bool(profile["telemetry"].get("opted_out", False))

    def set_telemetry_opt_out(self, owner_user_id: int, opted_out: bool) -> None:
        """Toggle the telemetry opt-out flag."""
        profile = self.get_user_profile(owner_user_id)
        telemetry = profile["telemetry"]
        telemetry["opted_out"] = opted_out
        self.set_user_telemetry(owner_user_id, telemetry)
