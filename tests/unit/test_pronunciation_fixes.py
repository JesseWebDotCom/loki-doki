from __future__ import annotations

import sqlite3

from lokidoki.core.pronunciation_fixes import (
    apply_pronunciation_fixes,
    delete_admin_fix,
    get_merged_fixes,
    list_admin_fixes,
    list_all_fixes,
    set_admin_fix,
)
from lokidoki.core.text_normalizer import normalize_for_speech


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE pronunciation_fixes ("
        "  word TEXT PRIMARY KEY,"
        "  spoken TEXT NOT NULL,"
        "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
        ")"
    )
    return conn


def test_apply_pronunciation_fixes_replaces_whole_words_case_insensitively():
    fixes = {"imax": "eye-max", "xd": "ex-dee"}
    result = apply_pronunciation_fixes(
        "See it in IMAX or XD format, not imax-lite.", fixes
    )
    assert "eye-max" in result
    assert "ex-dee" in result
    assert "IMAX" not in result


def test_apply_pronunciation_fixes_preserves_surrounding_text():
    fixes = {"starlight": "star-light"}
    result = apply_pronunciation_fixes("Visit Starlight Marquis 16 tonight.", fixes)
    assert result == "Visit star-light Marquis 16 tonight."


def test_apply_pronunciation_fixes_handles_empty_inputs():
    assert apply_pronunciation_fixes("", {"imax": "eye-max"}) == ""
    assert apply_pronunciation_fixes("hello", {}) == "hello"
    assert apply_pronunciation_fixes("hello", None) == "hello"


def test_admin_crud_round_trip():
    conn = _mem_db()
    assert list_admin_fixes(conn) == {}

    set_admin_fix(conn, "IMAX", "eye-max")
    assert list_admin_fixes(conn) == {"imax": "eye-max"}

    set_admin_fix(conn, "IMAX", "EYE max")
    assert list_admin_fixes(conn) == {"imax": "EYE max"}

    assert delete_admin_fix(conn, "IMAX")
    assert list_admin_fixes(conn) == {}
    assert not delete_admin_fix(conn, "IMAX")


def test_merged_fixes_admin_overrides_builtin():
    conn = _mem_db()
    # Override a builtin entry
    set_admin_fix(conn, "SQL", "ess queue ell")
    merged = get_merged_fixes(conn)
    assert merged["sql"] == "ess queue ell"
    # Builtins still present for non-overridden keys
    assert "imax" in merged


def test_list_all_fixes_shows_source_and_override_flag():
    conn = _mem_db()
    set_admin_fix(conn, "IMAX", "custom-imax")
    set_admin_fix(conn, "newword", "new-pronunciation")

    all_fixes = list_all_fixes(conn)
    by_word = {f["word"]: f for f in all_fixes}

    imax = by_word["imax"]
    assert imax["source"] == "admin"
    assert imax["overrides_builtin"] is True
    assert imax["spoken"] == "custom-imax"

    nw = by_word["newword"]
    assert nw["source"] == "admin"
    assert nw["overrides_builtin"] is False

    # A builtin that's not overridden
    assert by_word["hbo"]["source"] == "builtin"


def test_normalize_for_speech_applies_pronunciation_fixes():
    fixes = {"imax": "eye-max", "starlight": "star-light"}
    spoken = normalize_for_speech(
        "I see 5 theaters near 02108. Want Galaxy Cinemas 16, IMAX, Starlight Marquis 16?",
        pronunciation_fixes=fixes,
    )
    assert "eye-max" in spoken
    assert "star-light" in spoken
    assert "zero two one zero eight" in spoken
    assert "IMAX" not in spoken


def test_normalize_for_speech_without_fixes_is_unchanged():
    text = "Visit IMAX tonight."
    a = normalize_for_speech(text)
    b = normalize_for_speech(text, pronunciation_fixes=None)
    assert a == b
