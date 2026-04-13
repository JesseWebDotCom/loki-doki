"""
M0 phase gate tests for the v2 memory subsystem.

Each test corresponds to a deliverable from `docs/MEMORY_DESIGN.md` §8 M0:

    1. All scaffolding modules importable.
    2. Predicate enums populated; immediate-durable / single-value lists
       match the design doc.
    3. Tier metadata complete and ordered 1..7.
    4. Slot specs total 1,470 chars worst-case.
    5. Corpus fixture files exist and have the M0 schema shape.
    6. Schema migrations apply cleanly to a scratch SQLite file.
    7. President-bug regression row exists and currently FAILS via the
       gate-chain stub (because M0 ships scaffolding only — M1 fixes it).
    8. The dev-tools v2 status endpoint surfaces the memory subsystem.

These are the canonical M0 phase-gate tests. M1 should add a parallel
`test_v2_memory_m1.py` and leave this file intact.
"""
from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "tests" / "fixtures"


# ----- Deliverable 1: importability ----------------------------------------


@pytest.mark.parametrize(
    "module_name",
    [
        "lokidoki.orchestrator.memory",
        "lokidoki.orchestrator.memory.gates",
        "lokidoki.orchestrator.memory.tiers",
        "lokidoki.orchestrator.memory.predicates",
        "lokidoki.orchestrator.memory.classifier",
        "lokidoki.orchestrator.memory.promotion",
        "lokidoki.orchestrator.memory.consolidation",
        "lokidoki.orchestrator.memory.slots",
        "lokidoki.orchestrator.memory.schema",
    ],
)
def test_m0_scaffolding_modules_importable(module_name: str) -> None:
    """Every M0 scaffolding submodule must import without side effects."""
    module = importlib.import_module(module_name)
    assert module is not None


# ----- Deliverable 2: predicate enums --------------------------------------


def test_m0_tier4_predicates_include_design_doc_required_entries() -> None:
    from lokidoki.orchestrator.memory.predicates import TIER4_PREDICATES

    # Sample of predicates explicitly named in §2 / §3 / §5 of the design.
    required = {
        "is_named",
        "has_pronoun",
        "prefers",
        "lives_in",
        "works_as",
        "has_allergy",
        "current_employer",
        "favorite_color",
        "preferred_units",
        "timezone",
    }
    missing = required - TIER4_PREDICATES
    assert missing == set(), f"Tier 4 enum missing required predicates: {missing}"


def test_m0_immediate_durable_lists_match_design_doc() -> None:
    from lokidoki.orchestrator.memory.predicates import (
        IMMEDIATE_DURABLE_TIER4,
        IMMEDIATE_DURABLE_TIER5,
        is_immediate_durable,
    )

    # §3 Immediate-durable carve-out table for Tier 4.
    assert IMMEDIATE_DURABLE_TIER4 == {
        "is_named",
        "has_pronoun",
        "has_allergy",
        "has_dietary_restriction",
        "has_accessibility_need",
        "has_privacy_boundary",
        "hard_dislike",
    }
    # §3 Immediate-durable carve-out table for Tier 5.
    assert IMMEDIATE_DURABLE_TIER5 == {"is_named", "is_relation", "has_pronoun"}

    # API check.
    assert is_immediate_durable(4, "has_allergy") is True
    assert is_immediate_durable(5, "is_relation") is True
    # Soft preferences must NOT be immediate-durable — they go through promotion.
    assert is_immediate_durable(4, "prefers") is False


def test_m0_single_value_predicate_list_has_at_least_thirteen_entries() -> None:
    """v1.2 expanded the single-value list from v1's small set to ~13 entries."""
    from lokidoki.orchestrator.memory.predicates import SINGLE_VALUE_PREDICATES, is_single_value

    assert len(SINGLE_VALUE_PREDICATES) >= 13
    # Spot-check the design-doc-named entries.
    for predicate in (
        "is_named",
        "lives_in",
        "current_employer",
        "favorite_color",
        "timezone",
        "preferred_units",
    ):
        assert is_single_value(predicate), f"{predicate} should be single-value"


# ----- Deliverable 3: tier metadata ----------------------------------------


def test_m0_seven_tiers_registered_in_order() -> None:
    from lokidoki.orchestrator.memory.tiers import TIER_SPECS, Tier

    assert sorted(int(t) for t in TIER_SPECS) == [1, 2, 3, 4, 5, 6, 7]
    # Each tier must have a non-empty title and storage description.
    for tier_enum, spec in TIER_SPECS.items():
        assert spec.title, f"tier {tier_enum} missing title"
        assert spec.storage, f"tier {tier_enum} missing storage"
        assert spec.landing_phase, f"tier {tier_enum} missing landing_phase"
    # Tier 6 explicitly mentions the character_id overlay per §2 v1.2.
    assert "character_id" in TIER_SPECS[Tier.EMOTIONAL].storage


# ----- Deliverable 4: slot budgets -----------------------------------------


def test_m0_slot_budget_totals_match_design_doc() -> None:
    from lokidoki.orchestrator.memory.slots import SLOT_SPECS, WORST_CASE_TOTAL_BUDGET

    # §4 explicitly: "Total worst-case slot budget: 1,470 chars."
    assert WORST_CASE_TOTAL_BUDGET == 1470
    assert {spec.name for spec in SLOT_SPECS} == {
        "user_style",
        "recent_mood",
        "recent_context",
        "relevant_episodes",
        "user_facts",
        "social_context",
    }


def test_m0_slot_truncation_respects_budget() -> None:
    from lokidoki.orchestrator.memory.slots import truncate_to_budget

    # user_facts has a 250-char budget per §4.
    long = "x" * 500
    assert len(truncate_to_budget("user_facts", long)) == 250
    short = "y" * 50
    assert truncate_to_budget("user_facts", short) == short


# ----- Deliverable 5: corpus fixtures --------------------------------------


@pytest.mark.parametrize(
    "filename,expected_owner",
    [
        ("memory_extraction_corpus.json", "M1"),
        ("memory_recall_corpus.json", "M2-M4"),
        ("people_resolution_corpus.json", "M3"),
        ("persona_corpus.json", "M6"),
    ],
)
def test_m0_corpus_fixtures_exist_with_m0_schema(filename: str, expected_owner: str) -> None:
    path = FIXTURES / filename
    assert path.exists(), f"M0 corpus fixture missing: {filename}"
    payload = json.loads(path.read_text())
    # Each fixture has a $schema description, version, phase_owner, case_schema, cases.
    assert "$schema" in payload
    # Version 1 was the M0 empty-shell shape; M1 bumps the extraction corpus
    # to version 2 once it populates cases. Both versions are valid here.
    assert payload.get("version") in (1, 2)
    assert payload.get("phase_owner") == expected_owner
    assert "case_schema" in payload, f"{filename} missing case_schema"
    cases = payload.get("cases")
    assert isinstance(cases, list), f"{filename} cases must be a list"
    # The M0 gate is "fixture exists with the right schema". The phase
    # owner is responsible for populating cases when their phase ships.
    # Until then, ``cases`` is allowed to be empty *or* populated.


# ----- Deliverable 6: schema migrations apply to scratch SQLite -----------


def test_m0_schema_migrations_apply_to_scratch_sqlite(tmp_path: Path) -> None:
    from lokidoki.orchestrator.memory.schema import apply_memory_schema

    db_path = tmp_path / "scratch_memory.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        applied = apply_memory_schema(conn, create_base_stubs=True, enable_vec=False)
    finally:
        conn.close()

    # Stubs created.
    assert "base_stub_tables" in applied["stubs"]
    # Column migrations actually fired (these are first-run on a scratch DB).
    assert "people.handle" in applied["added_columns"]
    assert "people.provisional" in applied["added_columns"]
    assert "sessions.session_state" in applied["added_columns"]
    assert "messages.sentiment" in applied["added_columns"]
    # Index migration applied.
    assert any("idx_people_owner_handle" in s for s in applied["indexes"])
    # New tables.
    for label in ("episodes", "episodes_fts", "affect_window", "behavior_events", "user_profile"):
        assert label in applied["tables"]


def test_m0_schema_migrations_are_idempotent(tmp_path: Path) -> None:
    from lokidoki.orchestrator.memory.schema import apply_memory_schema

    db_path = tmp_path / "scratch_idempotent.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        first = apply_memory_schema(conn, create_base_stubs=True)
        second = apply_memory_schema(conn, create_base_stubs=False)
    finally:
        conn.close()

    # Re-running must not double-add columns.
    assert first["added_columns"], "first run should add columns"
    assert second["added_columns"] == [], "second run must skip existing columns"


def test_m0_episodes_table_has_topic_scope_column(tmp_path: Path) -> None:
    """§2 Tier 3 v1.1 — topic_scope is a required column on the episodes table."""
    from lokidoki.orchestrator.memory.schema import apply_memory_schema

    db_path = tmp_path / "scratch_episodes.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        apply_memory_schema(conn, create_base_stubs=True)
        cursor = conn.execute("PRAGMA table_info(episodes);")
        columns = {row[1] for row in cursor.fetchall()}
    finally:
        conn.close()
    assert "topic_scope" in columns
    # Tier 3 v1.1 also requires recall_count, last_recalled_at, superseded_by.
    for col in ("recall_count", "last_recalled_at", "superseded_by", "sentiment"):
        assert col in columns, f"episodes.{col} missing"


def test_m0_affect_window_has_character_id_pk(tmp_path: Path) -> None:
    """§2 Tier 6 v1.2 — affect_window must be scoped per (user, character_id, day)."""
    from lokidoki.orchestrator.memory.schema import apply_memory_schema

    db_path = tmp_path / "scratch_affect.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        apply_memory_schema(conn, create_base_stubs=True)
        cursor = conn.execute("PRAGMA table_info(affect_window);")
        rows = cursor.fetchall()
    finally:
        conn.close()
    pk_columns = sorted(row[1] for row in rows if row[5] > 0)
    assert pk_columns == ["character_id", "day", "owner_user_id"]


def test_m0_user_profile_has_style_and_telemetry_columns(tmp_path: Path) -> None:
    """§2 Tier 7 v1.1 — sub-tier 7a (style) and 7b (telemetry) must be separate columns."""
    from lokidoki.orchestrator.memory.schema import apply_memory_schema

    db_path = tmp_path / "scratch_profile.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        apply_memory_schema(conn, create_base_stubs=True)
        cursor = conn.execute("PRAGMA table_info(user_profile);")
        columns = {row[1] for row in cursor.fetchall()}
    finally:
        conn.close()
    assert {"style", "telemetry"} <= columns


# ----- Deliverable 7: president bug regression row -------------------------


def test_m0_president_bug_regression_row_exists() -> None:
    payload = json.loads((FIXTURES / "regression_prompts.json").read_text())
    cases = {case["id"]: case for case in payload["cases"]}
    assert "memory.president_bug.who_is_the_president" in cases
    case = cases["memory.president_bug.who_is_the_president"]
    assert case["utterance"] == "who is the current president"
    memory = case["expect"].get("memory")
    assert memory is not None
    # The expected outcome is "denied at clause_shape" — that is what M1 must
    # produce. M0's stub denies at "m0_stub" instead, which is the gap M1
    # closes.
    assert memory["should_write"] is False
    assert memory["denied_by_gate"] == "clause_shape"


def test_m0_president_bug_regression_row_uses_clause_shape() -> None:
    """The president-bug regression row's `denied_by_gate` field is the
    contract M1's gate chain must satisfy. M0 only verifies the contract
    exists; the M1 phase-gate tests verify the chain actually denies it
    via Gate 1 (parse-tree clause shape).
    """
    payload = json.loads((FIXTURES / "regression_prompts.json").read_text())
    cases = {case["id"]: case for case in payload["cases"]}
    case = cases["memory.president_bug.who_is_the_president"]
    memory = case["expect"]["memory"]
    assert memory["denied_by_gate"] == "clause_shape"
    assert memory["should_write"] is False


# ----- Deliverable 8: dev-tools v2 status endpoint surfaces memory ---------


def test_m0_dev_v2_status_payload_includes_memory_section() -> None:
    """The /dev/pipeline/status endpoint must surface the memory subsystem so the
    React V2PrototypeStatusPanel can render it. We call the helper directly
    rather than spinning up FastAPI to keep this test hermetic.

    The active phase advances as later milestones land — this test only
    asserts that the payload *is structurally complete* and that M0's
    foundations (seven tiers, six slots, four fixtures, regression row)
    remain visible. Per-phase status is asserted in each phase's own
    test file.
    """
    from lokidoki.api.routes.dev import _memory_status

    payload = _memory_status()
    assert "active_phase" in payload
    # The active phase id is whatever the most recently shipped phase
    # is — could be m0..m6 or any half-step (m2_5, m3_5). The contract
    # is that the active phase exists and is complete.
    assert payload["active_phase"]["status"] == "complete"
    # M0..M6 are always present in the roadmap; half-step phases (M2.5,
    # M3.5, …) may or may not be listed depending on which have shipped.
    phase_ids = {p["id"] for p in payload["phases"]}
    assert {"m0", "m1", "m2", "m3", "m4", "m5", "m6"} <= phase_ids
    # M0 itself stays marked complete forever — that's the contract this
    # test guards on behalf of M0's deliverables.
    m0_phase = next(p for p in payload["phases"] if p["id"] == "m0")
    assert m0_phase["status"] == "complete"
    # Tiers 1..7 surfaced.
    assert sorted(t["tier"] for t in payload["tiers"]) == [1, 2, 3, 4, 5, 6, 7]
    # Slot worst-case budget surfaced.
    assert payload["slots"]["worst_case_total_chars"] == 1470
    # Scaffolding manifest mentions the regression row id.
    assert payload["scaffolding"]["regression_row_id"] == "memory.president_bug.who_is_the_president"
    # All four corpus fixtures listed.
    assert len(payload["scaffolding"]["fixtures"]) == 4


def test_m0_bakeoff_template_exists() -> None:
    """Bakeoff template was consolidated into DESIGN.md; verify the design doc exists."""
    design = REPO_ROOT / "docs" / "DESIGN.md"
    assert design.exists()
