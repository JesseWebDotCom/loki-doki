"""Tier 2 — sessions + session_state mixin for MemoryStore (M4)."""
from __future__ import annotations

import json
from typing import Any

from lokidoki.orchestrator.memory.store_helpers import _now


class SessionsMixin:
    """Tier 2 session lifecycle and state methods."""

    def create_session(self, owner_user_id: int) -> int:
        """Open a new session row. Returns its id."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO sessions(owner_user_id, session_state) VALUES (?, ?)",
                (owner_user_id, json.dumps({})),
            )
            return int(cursor.lastrowid)

    def close_session(self, session_id: int) -> None:
        """Mark a session as closed by stamping ``ended_at``."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET ended_at = ? WHERE id = ?",
                (_now(), session_id),
            )

    def get_session_state(self, session_id: int) -> dict[str, Any]:
        """Return the session_state JSON for a session as a dict."""
        with self._lock:
            row = self._conn.execute(
                "SELECT session_state FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return {}
        raw = row["session_state"]
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def set_session_state(self, session_id: int, state: dict[str, Any]) -> None:
        """Replace the entire session_state for a session."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET session_state = ? WHERE id = ?",
                (json.dumps(state), session_id),
            )

    def update_last_seen(
        self, session_id: int, *, entity_type: str, entity_name: str,
    ) -> dict[str, Any]:
        """Record the most recent entity of ``entity_type`` for the session."""
        if not entity_type or not entity_name:
            return self.get_session_state(session_id)
        key = f"last_{entity_type}"
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen") or {}
            if not isinstance(last_seen, dict):
                last_seen = {}
            last_seen[key] = {"name": entity_name, "at": _now()}
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def bump_consolidation_counter(
        self, session_id: int, *,
        owner_user_id: int, subject: str, predicate: str,
    ) -> int:
        """Increment the in-session frequency counter. Returns post-increment count."""
        key = f"{owner_user_id}:{subject}:{predicate}"
        with self._lock:
            state = self.get_session_state(session_id)
            counters = state.get("consolidation") or {}
            if not isinstance(counters, dict):
                counters = {}
            entry = counters.get(key) or {
                "count": 0, "first_at": _now(), "last_at": _now(),
            }
            if not isinstance(entry, dict):
                entry = {"count": 0, "first_at": _now(), "last_at": _now()}
            entry["count"] = int(entry.get("count", 0)) + 1
            entry["last_at"] = _now()
            counters[key] = entry
            state["consolidation"] = counters
            self.set_session_state(session_id, state)
            return int(entry["count"])

    LAST_SEEN_MAX_TURN_DISTANCE: int = 5

    def decay_session_state(
        self, session_id: int, *, current_turn_index: int,
    ) -> dict[str, Any]:
        """Drop last-seen entries older than LAST_SEEN_MAX_TURN_DISTANCE turns."""
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen")
            if not isinstance(last_seen, dict) or not last_seen:
                return state
            max_dist = self.LAST_SEEN_MAX_TURN_DISTANCE
            keys_to_drop: list[str] = []
            for key, entry in last_seen.items():
                if not isinstance(entry, dict):
                    keys_to_drop.append(key)
                    continue
                turn = entry.get("turn")
                if turn is not None and (current_turn_index - int(turn)) > max_dist:
                    keys_to_drop.append(key)
            for key in keys_to_drop:
                del last_seen[key]
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def update_last_seen_with_turn(
        self, session_id: int, *,
        entity_type: str, entity_name: str, turn_index: int,
    ) -> dict[str, Any]:
        """Like ``update_last_seen`` but also records the turn index for decay."""
        if not entity_type or not entity_name:
            return self.get_session_state(session_id)
        key = f"last_{entity_type}"
        with self._lock:
            state = self.get_session_state(session_id)
            last_seen = state.get("last_seen") or {}
            if not isinstance(last_seen, dict):
                last_seen = {}
            last_seen[key] = {"name": entity_name, "at": _now(), "turn": turn_index}
            state["last_seen"] = last_seen
            self.set_session_state(session_id, state)
            return state

    def get_consolidation_counter(
        self, session_id: int, *,
        owner_user_id: int, subject: str, predicate: str,
    ) -> int:
        key = f"{owner_user_id}:{subject}:{predicate}"
        state = self.get_session_state(session_id)
        counters = state.get("consolidation") or {}
        if not isinstance(counters, dict):
            return 0
        entry = counters.get(key) or {}
        if not isinstance(entry, dict):
            return 0
        return int(entry.get("count", 0))
