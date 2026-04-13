"""Tests for the LokiDoki-backed v2 adapters (Phase 3 real wiring).

* :class:`LokiPeopleDBAdapter` reads the legacy ``people`` /
  ``relationships`` SQLite tables. We seed a temp DB with pop-culture
  characters (per CLAUDE.md mock data rule) and assert resolution.
* :class:`LokiSmartHomeAdapter` reads the smarthome_mock JSON state
  file. We write a temp file and assert device lookups.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from lokidoki.orchestrator.adapters.loki_people_db import LokiPeopleDBAdapter
from lokidoki.orchestrator.adapters.loki_smarthome import LokiSmartHomeAdapter


# ---- LokiPeopleDBAdapter ----------------------------------------------------


def _seed_people_db(conn: sqlite3.Connection) -> None:
    """Create a minimal people-graph schema and insert pop-culture rows."""
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS people (
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
        CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            relation TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0.6,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(owner_user_id, person_id, relation)
        );
        """
    )
    conn.execute("INSERT INTO users (id, username) VALUES (1, 'luke')")
    conn.executemany(
        "INSERT INTO people (owner_user_id, name, aliases, bucket) VALUES (?, ?, ?, ?)",
        [
            (1, "Padme", json.dumps(["mom", "mother", "mama"]), "family"),
            (1, "Anakin", json.dumps(["dad", "father"]), "family"),
            (1, "Leia", json.dumps(["sis"]), "family"),
            (1, "Han Solo", json.dumps(["han"]), "friend"),
            (1, "Obi-Wan", json.dumps(["ben", "obi"]), "family"),
        ],
    )
    conn.execute(
        "INSERT INTO relationships (owner_user_id, person_id, relation, confidence) "
        "SELECT 1, id, 'mother', 0.95 FROM people WHERE name = 'Padme'"
    )
    conn.execute(
        "INSERT INTO relationships (owner_user_id, person_id, relation, confidence) "
        "SELECT 1, id, 'father', 0.95 FROM people WHERE name = 'Anakin'"
    )
    conn.commit()


@pytest.fixture
def people_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _seed_people_db(conn)
    yield conn
    conn.close()


def test_loki_people_db_resolves_alias_to_real_row(people_conn):
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=1)
    match = adapter.resolve("mom")
    assert match is not None
    assert match.record.name == "Padme"
    assert match.record.relationship == "mother"
    assert match.matched_alias == "mom"


def test_loki_people_db_resolves_exact_name(people_conn):
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=1)
    match = adapter.resolve("Han Solo")
    assert match is not None
    assert match.record.name == "Han Solo"


def test_loki_people_db_returns_none_for_unknown(people_conn):
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=1)
    assert adapter.resolve("zorblax") is None


def test_loki_people_db_scopes_to_viewer_user(people_conn):
    """A different viewer_user_id sees no rows because we only seeded user 1."""
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=999)
    assert adapter.all() == ()
    assert adapter.resolve("mom") is None


def test_loki_people_db_returns_all_for_iteration(people_conn):
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=1)
    names = {record.name for record in adapter.all()}
    assert names == {"Padme", "Anakin", "Leia", "Han Solo", "Obi-Wan"}


def test_loki_people_db_family_priority_wins_when_multiple_match(people_conn):
    # Insert two people both nicknamed "ben" — one family, one friend.
    people_conn.execute(
        "INSERT INTO people (owner_user_id, name, aliases, bucket) VALUES "
        "(1, 'Bens Friend', ?, 'friend')",
        (json.dumps(["ben"]),),
    )
    people_conn.commit()
    adapter = LokiPeopleDBAdapter(people_conn, viewer_user_id=1)
    match = adapter.resolve("ben")
    assert match is not None
    # family bucket (priority 10) wins over friend (priority 30).
    assert match.record.name == "Obi-Wan"
    assert match.ambiguous is True


# ---- LokiSmartHomeAdapter ---------------------------------------------------


@pytest.fixture
def smarthome_state(tmp_path: Path) -> Path:
    state_file = tmp_path / "smarthome_state.json"
    state_file.write_text(
        json.dumps(
            {
                "kitchen_light": {"name": "Kitchen Light", "type": "light", "state": "off"},
                "living_room_light": {"name": "Living Room Light", "type": "light", "state": "on"},
                "thermostat": {"name": "Thermostat", "type": "climate", "state": "on", "temperature": 22},
                "front_door_lock": {"name": "Front Door Lock", "type": "lock", "state": "locked"},
            }
        )
    )
    return state_file


def test_loki_smarthome_resolves_kitchen_light_alias(smarthome_state):
    adapter = LokiSmartHomeAdapter(smarthome_state)
    match = adapter.resolve("kitchen light")
    assert match is not None
    assert match.record.entity_id == "light.kitchen_light"
    assert match.record.domain == "light"


def test_loki_smarthome_resolves_short_alias_without_trailing_word(smarthome_state):
    adapter = LokiSmartHomeAdapter(smarthome_state)
    match = adapter.resolve("kitchen")
    assert match is not None
    assert match.record.friendly_name == "Kitchen Light"


def test_loki_smarthome_resolves_thermostat_by_friendly_name(smarthome_state):
    adapter = LokiSmartHomeAdapter(smarthome_state)
    match = adapter.resolve("thermostat")
    assert match is not None
    assert match.record.domain == "climate"


def test_loki_smarthome_returns_none_for_unknown(smarthome_state):
    adapter = LokiSmartHomeAdapter(smarthome_state)
    assert adapter.resolve("teleporter") is None


def test_loki_smarthome_returns_all_devices(smarthome_state):
    adapter = LokiSmartHomeAdapter(smarthome_state)
    entity_ids = {device.entity_id for device in adapter.all()}
    assert "light.kitchen_light" in entity_ids
    assert "climate.thermostat" in entity_ids
    assert "lock.front_door_lock" in entity_ids


def test_loki_smarthome_handles_missing_state_file(tmp_path):
    adapter = LokiSmartHomeAdapter(tmp_path / "nonexistent.json")
    assert adapter.all() == ()
    assert adapter.resolve("anything") is None


def test_loki_smarthome_handles_corrupt_state_file(tmp_path):
    state_file = tmp_path / "broken.json"
    state_file.write_text("not valid json {{{")
    adapter = LokiSmartHomeAdapter(state_file)
    assert adapter.all() == ()
