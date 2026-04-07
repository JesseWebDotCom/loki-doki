"""Tests for the contradiction / belief revision module.

Spins up an in-memory SQLite DB with the real schema and exercises the
contradiction handling end-to-end through ``upsert_fact``.
"""
from __future__ import annotations

import sqlite3

import pytest

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core import memory_sql as sql
from lokidoki.core import memory_people_sql as psql


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "test.db"
    c, _ = open_and_migrate(str(db))
    user_id = sql.get_or_create_user(c, "tester")
    yield c, user_id
    c.close()


def _upsert(c, user_id, **kw):
    return sql.upsert_fact(
        c,
        user_id=user_id,
        category="general",
        source_message_id=None,
        **kw,
    )


class TestContradictionResolution:
    def test_single_value_predicate_revision(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Artie")
        # First fact: name=Artie
        _, _, r1 = _upsert(
            c, uid, subject="artie", predicate="name", value="Artie",
            subject_type="person", subject_ref_id=pid,
        )
        assert r1["action"] == "none"
        # Conflicting fact: name=Art
        _, _, r2 = _upsert(
            c, uid, subject="artie", predicate="name", value="Art",
            subject_type="person", subject_ref_id=pid,
        )
        assert r2["action"] in ("revise", "reject_loser")
        assert r2["loser_value"] == "Artie"

    def test_multi_value_coexists(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Tom")
        _upsert(c, uid, subject="tom", predicate="likes", value="Halo",
                subject_type="person", subject_ref_id=pid)
        _, _, r2 = _upsert(
            c, uid, subject="tom", predicate="likes", value="Doom",
            subject_type="person", subject_ref_id=pid,
        )
        assert r2["action"] == "none"

    def test_explicit_negation_supersedes(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Artie")
        _upsert(c, uid, subject="artie", predicate="name", value="Artie",
                subject_type="person", subject_ref_id=pid)
        _, _, r2 = _upsert(
            c, uid, subject="artie", predicate="name", value="Art",
            subject_type="person", subject_ref_id=pid,
            negates_previous=True,
        )
        assert r2["action"] == "supersede"
        # The old row must now be status='superseded'.
        rows = c.execute(
            "SELECT value, status FROM facts WHERE owner_user_id = ? "
            "AND subject_ref_id = ? AND predicate = ?",
            (uid, pid, "name"),
        ).fetchall()
        statuses = {(r["value"], r["status"]) for r in rows}
        assert ("Artie", "superseded") in statuses
        assert ("Art", "active") in statuses

    def test_repeat_confirms_existing(self, conn):
        c, uid = conn
        _, conf1, r1 = _upsert(c, uid, subject="self", predicate="loves",
                               value="coffee")
        _, conf2, r2 = _upsert(c, uid, subject="self", predicate="loves",
                               value="coffee")
        assert r2["action"] == "confirmed"
        assert conf2 > conf1
