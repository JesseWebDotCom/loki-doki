"""Tests for the contradiction / belief revision module.

Exercises ``detect_and_resolve_contradiction`` directly against a real
SQLite DB. The helper is the engine the gate-chain writer calls when a
single-value predicate gets a new value or the decomposer flags an
explicit negation.
"""
from __future__ import annotations

import pytest

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core import memory_sql as sql
from lokidoki.core import memory_people_sql as psql
from lokidoki.core.memory_contradiction import detect_and_resolve_contradiction


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "test.db"
    c, _ = open_and_migrate(str(db))
    user_id = sql.get_or_create_user(c, "tester")
    yield c, user_id
    c.close()


def _insert_fact(
    c,
    *,
    user_id: int,
    subject: str,
    predicate: str,
    value: str,
    subject_type: str = "self",
    subject_ref_id: int | None = None,
    confidence: float = 0.6,
) -> int:
    cur = c.execute(
        "INSERT INTO facts (owner_user_id, subject, subject_type, "
        "subject_ref_id, predicate, value, category, confidence, status) "
        "VALUES (?, ?, ?, ?, ?, ?, 'general', ?, 'active')",
        (user_id, subject, subject_type, subject_ref_id, predicate, value, confidence),
    )
    c.commit()
    return int(cur.lastrowid)


class TestContradictionResolution:
    def test_single_value_predicate_revision(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Luke")
        _insert_fact(
            c, user_id=uid, subject="luke", predicate="name", value="Luke",
            subject_type="person", subject_ref_id=pid,
        )
        report = detect_and_resolve_contradiction(
            c, user_id=uid, subject="luke", subject_ref_id=pid,
            predicate="name", new_value="Art",
        )
        assert report["action"] in ("revise", "reject_loser")
        assert report["loser_value"] == "Luke"

    def test_multi_value_coexists(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Tom")
        _insert_fact(
            c, user_id=uid, subject="tom", predicate="likes", value="Halo",
            subject_type="person", subject_ref_id=pid,
        )
        report = detect_and_resolve_contradiction(
            c, user_id=uid, subject="tom", subject_ref_id=pid,
            predicate="likes", new_value="Doom",
        )
        assert report["action"] == "none"

    def test_explicit_negation_supersedes(self, conn):
        c, uid = conn
        pid = psql.create_person(c, uid, "Luke")
        _insert_fact(
            c, user_id=uid, subject="luke", predicate="name", value="Luke",
            subject_type="person", subject_ref_id=pid,
        )
        report = detect_and_resolve_contradiction(
            c, user_id=uid, subject="luke", subject_ref_id=pid,
            predicate="name", new_value="Art", negates_previous=True,
        )
        assert report["action"] == "supersede"
        rows = c.execute(
            "SELECT value, status FROM facts WHERE owner_user_id = ? "
            "AND subject_ref_id = ? AND predicate = ?",
            (uid, pid, "name"),
        ).fetchall()
        statuses = {(r["value"], r["status"]) for r in rows}
        assert ("Luke", "superseded") in statuses

    def test_no_existing_row_is_none(self, conn):
        c, uid = conn
        report = detect_and_resolve_contradiction(
            c, user_id=uid, subject="self", subject_ref_id=None,
            predicate="name", new_value="Jesse",
        )
        assert report["action"] == "none"
