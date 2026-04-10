"""Two-tier pronunciation fix system: built-in JSON + admin DB overrides.

Built-in fixes ship in ``data/pronunciation_builtin.json`` and cover
common brand names, acronyms, and words Piper mispronounces. Admins can
add, update, or delete fixes via the API — those are stored in the
``pronunciation_fixes`` DB table and override built-ins on conflict.

The merged result is a case-insensitive word→spoken mapping applied as a
whole-word replacement pass inside the text normalizer.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from typing import Any

_BUILTIN_PATH = os.path.join("data", "pronunciation_builtin.json")


def _load_builtin() -> dict[str, str]:
    """Load the shipped pronunciation fixes from the JSON file."""
    if not os.path.exists(_BUILTIN_PATH):
        return {}
    try:
        with open(_BUILTIN_PATH, "r") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}
    return {
        k.lower(): str(v)
        for k, v in raw.items()
        if not k.startswith("_") and isinstance(v, str)
    }


# ---- DB helpers (run via MemoryProvider.run_sync) -------------------------


def list_admin_fixes(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT word, spoken FROM pronunciation_fixes").fetchall()
    return {r["word"]: r["spoken"] for r in rows}


def get_admin_fix(conn: sqlite3.Connection, word: str) -> dict[str, str] | None:
    row = conn.execute(
        "SELECT word, spoken, updated_at FROM pronunciation_fixes WHERE word = ?",
        (word.lower().strip(),),
    ).fetchone()
    return dict(row) if row else None


def set_admin_fix(conn: sqlite3.Connection, word: str, spoken: str) -> None:
    conn.execute(
        "INSERT INTO pronunciation_fixes (word, spoken, updated_at) "
        "VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(word) DO UPDATE SET "
        "spoken = excluded.spoken, updated_at = excluded.updated_at",
        (word.lower().strip(), spoken.strip()),
    )
    conn.commit()


def delete_admin_fix(conn: sqlite3.Connection, word: str) -> bool:
    cur = conn.execute(
        "DELETE FROM pronunciation_fixes WHERE word = ?",
        (word.lower().strip(),),
    )
    conn.commit()
    return cur.rowcount > 0


# ---- merge & apply -------------------------------------------------------


def get_merged_fixes(conn: sqlite3.Connection) -> dict[str, str]:
    """Return ``{**builtin, **admin}`` — admin overrides win."""
    merged = _load_builtin()
    merged.update(list_admin_fixes(conn))
    return merged


def apply_pronunciation_fixes(text: str, fixes: dict[str, str]) -> str:
    """Replace whole-word occurrences using the merged fix map.

    Case-insensitive matching, preserves surrounding punctuation.
    """
    if not fixes or not text:
        return text

    # Build a single regex alternation sorted longest-first so multi-word
    # keys match before their substrings.
    sorted_keys = sorted(fixes.keys(), key=len, reverse=True)
    pattern = re.compile(
        r"\b(" + "|".join(re.escape(k) for k in sorted_keys) + r")\b",
        re.IGNORECASE,
    )
    return pattern.sub(lambda m: fixes[m.group(0).lower()], text)


# ---- convenience for routes ----------------------------------------------


def list_all_fixes(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return every fix (builtin + admin) with source metadata for the UI."""
    builtin = _load_builtin()
    admin = list_admin_fixes(conn)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for word, spoken in admin.items():
        out.append({
            "word": word,
            "spoken": spoken,
            "source": "admin",
            "overrides_builtin": word in builtin,
        })
        seen.add(word)
    for word, spoken in builtin.items():
        if word not in seen:
            out.append({"word": word, "spoken": spoken, "source": "builtin"})
    out.sort(key=lambda r: r["word"])
    return out
