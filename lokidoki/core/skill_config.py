"""Per-skill configuration storage (global + per-user tiers).

Two tables back this:
  * ``skill_config_global`` — admin-set values for every user
  * ``skill_config_user``   — per-user overrides

The runtime always *merges* the two: globals first, user values on top.
That gives the natural semantics where an admin can pre-fill an API
key everyone shares, and any individual user can either accept it,
override it with their own, or set values the global tier never
provides at all (zip code, units, default location...).

Values are stored as JSON strings so non-string types (int, bool,
float) survive a round trip without forcing every read site to parse.
The skill manifest declares what fields exist and what type each one
should be via a ``config_schema`` block (see weather_owm/manifest.json
for the canonical example):

    "config_schema": {
        "global": [
            {"key": "owm_api_key", "type": "string", "secret": true,
             "label": "OpenWeatherMap API key", "required": true}
        ],
        "user": [
            {"key": "default_location", "type": "string",
             "label": "Default location",
             "description": "Used when you ask 'what's the weather' with no city",
             "default": ""}
        ]
    }

The schema is purely descriptive — it drives the settings UI and
input validation in the API routes. Skills themselves only see the
merged config dict at execute time and decide what to do with it.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional


# ---- sync helpers (run via MemoryProvider.run_sync) ---------------------


def _decode(value: str) -> Any:
    """Best-effort JSON decode; falls back to the raw string.

    Old rows or hand-edited rows might not be valid JSON. Returning
    the raw text in that case keeps reads from blowing up the whole
    skill execution.
    """
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


def _encode(value: Any) -> str:
    return json.dumps(value)


def get_global_config(conn: sqlite3.Connection, skill_id: str) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT key, value FROM skill_config_global WHERE skill_id = ?",
        (skill_id,),
    ).fetchall()
    return {r["key"]: _decode(r["value"]) for r in rows}


def get_user_config(
    conn: sqlite3.Connection, user_id: int, skill_id: str
) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT key, value FROM skill_config_user "
        "WHERE user_id = ? AND skill_id = ?",
        (user_id, skill_id),
    ).fetchall()
    return {r["key"]: _decode(r["value"]) for r in rows}


def get_merged_config(
    conn: sqlite3.Connection, user_id: Optional[int], skill_id: str
) -> dict[str, Any]:
    """Return ``{**global, **user}`` for one skill. User overrides win."""
    merged = get_global_config(conn, skill_id)
    if user_id is not None:
        merged.update(get_user_config(conn, user_id, skill_id))
    return merged


def set_global_value(
    conn: sqlite3.Connection, skill_id: str, key: str, value: Any
) -> None:
    conn.execute(
        "INSERT INTO skill_config_global (skill_id, key, value, updated_at) "
        "VALUES (?, ?, ?, datetime('now')) "
        "ON CONFLICT(skill_id, key) DO UPDATE SET "
        "value = excluded.value, updated_at = excluded.updated_at",
        (skill_id, key, _encode(value)),
    )
    conn.commit()


def set_user_value(
    conn: sqlite3.Connection,
    user_id: int,
    skill_id: str,
    key: str,
    value: Any,
) -> None:
    conn.execute(
        "INSERT INTO skill_config_user (user_id, skill_id, key, value, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id, skill_id, key) DO UPDATE SET "
        "value = excluded.value, updated_at = excluded.updated_at",
        (user_id, skill_id, key, _encode(value)),
    )
    conn.commit()


def delete_global_value(conn: sqlite3.Connection, skill_id: str, key: str) -> bool:
    cur = conn.execute(
        "DELETE FROM skill_config_global WHERE skill_id = ? AND key = ?",
        (skill_id, key),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_user_value(
    conn: sqlite3.Connection, user_id: int, skill_id: str, key: str
) -> bool:
    cur = conn.execute(
        "DELETE FROM skill_config_user "
        "WHERE user_id = ? AND skill_id = ? AND key = ?",
        (user_id, skill_id, key),
    )
    conn.commit()
    return cur.rowcount > 0


# ---- schema validation ---------------------------------------------------


_ALLOWED_TYPES = {"string", "secret", "number", "integer", "boolean"}


def coerce_value(value: Any, field_type: str) -> Any:
    """Coerce an inbound API value to its declared manifest type.

    Raises ValueError on a hard mismatch so the caller can return 400.
    Empty strings are passed through unchanged for string/secret fields
    so the UI can clear a value by submitting "".
    """
    t = (field_type or "string").lower()
    if t not in _ALLOWED_TYPES:
        raise ValueError(f"unknown field type: {field_type}")
    if value is None:
        return ""
    if t in ("string", "secret"):
        return str(value)
    if t == "integer":
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"expected integer, got {value!r}") from exc
    if t == "number":
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"expected number, got {value!r}") from exc
    if t == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        raise ValueError(f"expected boolean, got {value!r}")
    return value  # unreachable


def find_field(schema: dict, tier: str, key: str) -> Optional[dict]:
    """Look up a field declaration inside a manifest's ``config_schema``.

    ``tier`` is ``"global"`` or ``"user"``. Returns ``None`` when the
    skill does not declare that field on that tier — callers should
    treat that as 404 so misuse doesn't silently write garbage rows.
    """
    if not schema:
        return None
    fields = schema.get(tier) or []
    for f in fields:
        if isinstance(f, dict) and f.get("key") == key:
            return f
    return None


# ---- manual enable/disable toggles --------------------------------------


def get_global_toggle(conn: sqlite3.Connection, skill_id: str) -> bool:
    """Return the admin-set toggle. Defaults to True when unset."""
    row = conn.execute(
        "SELECT enabled FROM skill_enabled_global WHERE skill_id = ?",
        (skill_id,),
    ).fetchone()
    return True if row is None else bool(row["enabled"])


def get_user_toggle(
    conn: sqlite3.Connection, user_id: int, skill_id: str
) -> bool:
    row = conn.execute(
        "SELECT enabled FROM skill_enabled_user WHERE user_id = ? AND skill_id = ?",
        (user_id, skill_id),
    ).fetchone()
    return True if row is None else bool(row["enabled"])


def set_global_toggle(
    conn: sqlite3.Connection, skill_id: str, enabled: bool
) -> None:
    conn.execute(
        "INSERT INTO skill_enabled_global (skill_id, enabled, updated_at) "
        "VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(skill_id) DO UPDATE SET "
        "enabled = excluded.enabled, updated_at = excluded.updated_at",
        (skill_id, 1 if enabled else 0),
    )
    conn.commit()


def set_user_toggle(
    conn: sqlite3.Connection,
    user_id: int,
    skill_id: str,
    enabled: bool,
) -> None:
    conn.execute(
        "INSERT INTO skill_enabled_user (user_id, skill_id, enabled, updated_at) "
        "VALUES (?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id, skill_id) DO UPDATE SET "
        "enabled = excluded.enabled, updated_at = excluded.updated_at",
        (user_id, skill_id, 1 if enabled else 0),
    )
    conn.commit()


def required_keys(schema: dict) -> list[str]:
    """Return the de-duplicated list of required field keys across tiers.

    A field marked ``required: true`` in either ``global`` or ``user``
    must end up with a non-empty value in the merged config for the
    skill to be considered usable. Listing the same key in both tiers
    (e.g. an API key that defaults globally but a user may override)
    only counts once — the merge layer already handles precedence.
    """
    if not schema:
        return []
    seen: list[str] = []
    for tier in ("global", "user"):
        for f in schema.get(tier) or []:
            if isinstance(f, dict) and f.get("required") and f.get("key"):
                if f["key"] not in seen:
                    seen.append(f["key"])
    return seen


def _is_filled(value: Any) -> bool:
    """Treat empty string / None / empty container as 'not set'.

    Booleans and numbers are always considered filled even when
    falsy — ``False`` and ``0`` are deliberate values, not absence.
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) > 0
    return True


def check_enabled(merged: dict[str, Any], schema: dict) -> tuple[bool, list[str]]:
    """Decide whether a skill has enough config to run.

    Returns ``(enabled, missing_keys)``. A skill with no
    ``config_schema`` (or no required fields) is always enabled.
    The orchestrator uses this together with the manual toggles to
    decide whether to route to a skill — see ``compute_skill_state``.
    """
    missing = [k for k in required_keys(schema) if not _is_filled(merged.get(k))]
    return (len(missing) == 0, missing)


def compute_skill_state(
    *,
    merged_config: dict[str, Any],
    schema: dict,
    global_toggle: bool,
    user_toggle: bool,
) -> dict[str, Any]:
    """Combine the three independent gates into one effective state.

    Three gates AND together to decide whether the orchestrator will
    actually call the skill on this turn:

      1. ``global_toggle`` — admin manual switch (default on)
      2. ``user_toggle``   — per-user manual switch (default on)
      3. config check      — required fields filled

    The returned dict carries enough detail for the UI to show *why*
    a skill is off: was it switched off, or just missing a key?
    Stable shape:
        {
          "enabled": bool,
          "config_ok": bool,
          "missing_required": [str],
          "global_toggle": bool,
          "user_toggle": bool,
          "disabled_reason": "global_toggle" | "user_toggle" | "config" | None,
        }
    """
    config_ok, missing = check_enabled(merged_config, schema)
    enabled = bool(global_toggle and user_toggle and config_ok)
    if enabled:
        reason = None
    elif not global_toggle:
        reason = "global_toggle"
    elif not user_toggle:
        reason = "user_toggle"
    else:
        reason = "config"
    return {
        "enabled": enabled,
        "config_ok": config_ok,
        "missing_required": missing,
        "global_toggle": global_toggle,
        "user_toggle": user_toggle,
        "disabled_reason": reason,
    }


def mask_secrets(values: dict[str, Any], schema: dict, tier: str) -> dict[str, Any]:
    """Replace secret-typed field values with a redacted marker.

    The settings UI never needs to read back a secret — it only needs
    to know whether one is set. We return ``{"_set": True}`` instead
    of the raw value so the form can render "Configured (click to
    replace)" affordances without leaking the key.
    """
    if not schema:
        return dict(values)
    fields = {f["key"]: f for f in (schema.get(tier) or []) if isinstance(f, dict)}
    out: dict[str, Any] = {}
    for k, v in values.items():
        spec = fields.get(k)
        if spec and (spec.get("type") == "secret" or spec.get("secret")):
            out[k] = {"_set": bool(v)}
        else:
            out[k] = v
    return out
