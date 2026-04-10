from __future__ import annotations

import sqlite3

from lokidoki.core.person_pronunciation import (
    collect_person_pronunciation_fixes,
    delete_person_pronunciation,
    list_person_pronunciations,
    set_person_pronunciation,
)
from lokidoki.core.text_normalizer import normalize_for_speech


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            aliases TEXT NOT NULL DEFAULT '[]',
            bucket TEXT NOT NULL DEFAULT 'family',
            living_status TEXT NOT NULL DEFAULT 'unknown',
            birth_date TEXT,
            death_date TEXT,
            preferred_photo_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE person_pronunciation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            name_part TEXT NOT NULL DEFAULT 'first',
            written TEXT NOT NULL,
            spoken TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(person_id, name_part)
        );
    """)
    return conn


def _add_person(conn: sqlite3.Connection, user_id: int, name: str) -> int:
    cur = conn.execute(
        "INSERT INTO people (owner_user_id, name) VALUES (?, ?)",
        (user_id, name),
    )
    conn.commit()
    return cur.lastrowid or 0


def test_crud_round_trip():
    conn = _mem_db()
    pid = _add_person(conn, 1, "Nguyen Tran")

    assert list_person_pronunciations(conn, pid) == []

    set_person_pronunciation(conn, pid, "last", "Nguyen", "win")
    fixes = list_person_pronunciations(conn, pid)
    assert len(fixes) == 1
    assert fixes[0]["name_part"] == "last"
    assert fixes[0]["written"] == "Nguyen"
    assert fixes[0]["spoken"] == "win"

    # Upsert updates the existing row
    set_person_pronunciation(conn, pid, "last", "Nguyen", "nwin")
    fixes = list_person_pronunciations(conn, pid)
    assert len(fixes) == 1
    assert fixes[0]["spoken"] == "nwin"

    assert delete_person_pronunciation(conn, pid, "last")
    assert list_person_pronunciations(conn, pid) == []
    assert not delete_person_pronunciation(conn, pid, "last")


def test_multiple_name_parts_per_person():
    conn = _mem_db()
    pid = _add_person(conn, 1, "Siobhan Nguyen")

    set_person_pronunciation(conn, pid, "first", "Siobhan", "shih-vawn")
    set_person_pronunciation(conn, pid, "last", "Nguyen", "win")

    fixes = list_person_pronunciations(conn, pid)
    assert len(fixes) == 2
    parts = {f["name_part"]: f["spoken"] for f in fixes}
    assert parts["first"] == "shih-vawn"
    assert parts["last"] == "win"


def test_collect_gathers_all_person_fixes_for_user():
    conn = _mem_db()
    pid1 = _add_person(conn, 1, "Siobhan Nguyen")
    pid2 = _add_person(conn, 1, "Aoife Nguyen")
    _add_person(conn, 2, "Other User Person")  # different user

    set_person_pronunciation(conn, pid1, "first", "Siobhan", "shih-vawn")
    set_person_pronunciation(conn, pid1, "last", "Nguyen", "win")
    set_person_pronunciation(conn, pid2, "first", "Aoife", "ee-fah")

    fixes = collect_person_pronunciation_fixes(conn, owner_user_id=1)
    assert fixes["siobhan"] == "shih-vawn"
    assert fixes["nguyen"] == "win"
    assert fixes["aoife"] == "ee-fah"


def test_collect_returns_empty_for_user_with_no_pronunciations():
    conn = _mem_db()
    _add_person(conn, 1, "Normal Name")
    assert collect_person_pronunciation_fixes(conn, owner_user_id=1) == {}


def test_person_fixes_apply_through_normalizer():
    fixes = {"nguyen": "win", "siobhan": "shih-vawn"}
    spoken = normalize_for_speech(
        "Siobhan Nguyen called about the appointment.",
        pronunciation_fixes=fixes,
    )
    assert "shih-vawn" in spoken
    assert "win" in spoken
    assert "Nguyen" not in spoken
    assert "Siobhan" not in spoken


def test_last_name_fix_applies_to_multiple_family_members():
    """A last-name fix set on one person applies to text mentioning any family member."""
    conn = _mem_db()
    pid1 = _add_person(conn, 1, "Tran Nguyen")
    _add_person(conn, 1, "Linh Nguyen")

    # Set last name pronunciation on one person
    set_person_pronunciation(conn, pid1, "last", "Nguyen", "win")

    # Collect fixes — the written form "Nguyen" -> "win" is in the dict
    fixes = collect_person_pronunciation_fixes(conn, owner_user_id=1)

    # Apply to text mentioning any Nguyen
    spoken = normalize_for_speech(
        "Tran Nguyen and Linh Nguyen are siblings.",
        pronunciation_fixes=fixes,
    )
    assert spoken.count("win") == 2
    assert "Nguyen" not in spoken
