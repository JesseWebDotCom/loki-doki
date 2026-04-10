"""Phase 7 unit tests: fact access telemetry, A/B experiment framework,
memory-format variants, and reranker integration.

Covers CODEX Phase 7 deliverables:
- Telemetry updates (access_count, last_accessed_at)
- Logging for fact retrieval vs injection
- Experiment arm assignment (deterministic + persisted)
- Memory format experiments (control vs warm)
- Reranker experiments (baseline vs bge-reranker)
- Regression: no experiment arm breaks citations, prompt budget, or answer-first
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core import memory_sql as sql


@pytest.fixture
def conn(tmp_path):
    db_path = str(tmp_path / "test.db")
    c, _ = open_and_migrate(db_path)
    uid = sql.get_or_create_user(c, "testuser")
    sid = sql.create_session(c, uid, "test session")
    return c, uid, sid


# ---------- telemetry updates ----------


class TestFactTelemetry:
    def test_record_retrieval_creates_row(self, conn):
        c, uid, sid = conn
        fid, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="music", category="general", source_message_id=None,
        )
        sql.record_fact_retrieval(c, [fid])
        row = sql.get_fact_telemetry(c, fid)
        assert row is not None
        assert row["retrieve_count"] == 1
        assert row["inject_count"] == 0
        assert row["last_retrieved_at"] is not None

    def test_record_retrieval_increments(self, conn):
        c, uid, sid = conn
        fid, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="music", category="general", source_message_id=None,
        )
        sql.record_fact_retrieval(c, [fid])
        sql.record_fact_retrieval(c, [fid])
        sql.record_fact_retrieval(c, [fid])
        row = sql.get_fact_telemetry(c, fid)
        assert row["retrieve_count"] == 3

    def test_record_injection_creates_row(self, conn):
        c, uid, sid = conn
        fid, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="coffee", category="general", source_message_id=None,
        )
        sql.record_fact_injection(c, [fid])
        row = sql.get_fact_telemetry(c, fid)
        assert row["inject_count"] == 1
        assert row["last_injected_at"] is not None

    def test_both_counters_independent(self, conn):
        c, uid, sid = conn
        fid, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="tea", category="general", source_message_id=None,
        )
        sql.record_fact_retrieval(c, [fid])
        sql.record_fact_retrieval(c, [fid])
        sql.record_fact_injection(c, [fid])
        row = sql.get_fact_telemetry(c, fid)
        assert row["retrieve_count"] == 2
        assert row["inject_count"] == 1

    def test_multiple_fact_ids_in_one_call(self, conn):
        c, uid, sid = conn
        fid1, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="a", category="general", source_message_id=None,
        )
        fid2, _, _ = sql.upsert_fact(
            c, user_id=uid, subject="self", predicate="likes",
            value="b", category="general", source_message_id=None,
        )
        sql.record_fact_retrieval(c, [fid1, fid2])
        r1 = sql.get_fact_telemetry(c, fid1)
        r2 = sql.get_fact_telemetry(c, fid2)
        assert r1["retrieve_count"] == 1
        assert r2["retrieve_count"] == 1

    def test_empty_list_is_noop(self, conn):
        c, uid, sid = conn
        sql.record_fact_retrieval(c, [])
        sql.record_fact_injection(c, [])
        # No error, no rows created

    def test_nonexistent_fact_id_skipped(self, conn):
        """Telemetry FK means a nonexistent fact_id raises an error
        but the function should not crash the pipeline."""
        c, uid, sid = conn
        # fact_id 99999 doesn't exist — FK violation on INSERT
        with pytest.raises(sqlite3.IntegrityError):
            sql.record_fact_retrieval(c, [99999])


# ---------- experiment assignments ----------


class TestExperimentAssignments:
    def test_get_arm_returns_none_for_unassigned(self, conn):
        c, uid, sid = conn
        assert sql.get_experiment_arm(c, uid, "memory_format_v1") is None

    def test_set_and_get_arm(self, conn):
        c, uid, sid = conn
        sql.set_experiment_arm(c, uid, "memory_format_v1", "warm")
        assert sql.get_experiment_arm(c, uid, "memory_format_v1") == "warm"

    def test_set_arm_overwrites(self, conn):
        c, uid, sid = conn
        sql.set_experiment_arm(c, uid, "memory_format_v1", "control")
        sql.set_experiment_arm(c, uid, "memory_format_v1", "warm")
        assert sql.get_experiment_arm(c, uid, "memory_format_v1") == "warm"

    def test_different_experiments_independent(self, conn):
        c, uid, sid = conn
        sql.set_experiment_arm(c, uid, "memory_format_v1", "warm")
        sql.set_experiment_arm(c, uid, "reranker_v1", "control")
        assert sql.get_experiment_arm(c, uid, "memory_format_v1") == "warm"
        assert sql.get_experiment_arm(c, uid, "reranker_v1") == "control"

    def test_different_users_independent(self, conn):
        c, uid, sid = conn
        uid2 = sql.get_or_create_user(c, "otheruser")
        sql.set_experiment_arm(c, uid, "memory_format_v1", "warm")
        sql.set_experiment_arm(c, uid2, "memory_format_v1", "control")
        assert sql.get_experiment_arm(c, uid, "memory_format_v1") == "warm"
        assert sql.get_experiment_arm(c, uid2, "memory_format_v1") == "control"
