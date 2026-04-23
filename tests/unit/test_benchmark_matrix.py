"""Unit tests for the benchmark matrix endpoint and stats helpers.

The matrix endpoint runs N prompts x M configs, returning per-run
trace_summary + aggregate stats (p50/p95/mean/error_rate) so the dev
tools UI can compare models/modes at a glance rather than via
single-prompt runs.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from lokidoki.api.routes.dev import (
    BENCHMARK_CORPUS_DIR,
    _grade_output,
    _percentile,
    _summarize_grades,
    _summarize_timings,
    list_benchmark_corpus_payload,
)


def test_percentile_returns_expected_value_for_sorted_inputs() -> None:
    values = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]
    assert _percentile(values, 50) == pytest.approx(55.0)
    assert _percentile(values, 95) == pytest.approx(95.5)


def test_percentile_handles_empty_list() -> None:
    assert _percentile([], 50) == 0.0


def test_percentile_handles_single_value() -> None:
    assert _percentile([42.0], 95) == pytest.approx(42.0)


def test_summarize_timings_reports_count_mean_and_percentiles() -> None:
    timings = [100.0, 150.0, 200.0, 250.0, 300.0]
    summary = _summarize_timings(timings, error_count=1)

    assert summary["count"] == 5
    assert summary["errors"] == 1
    assert summary["mean_ms"] == pytest.approx(200.0)
    assert summary["min_ms"] == pytest.approx(100.0)
    assert summary["max_ms"] == pytest.approx(300.0)
    assert summary["p50_ms"] == pytest.approx(200.0)
    assert summary["p95_ms"] == pytest.approx(290.0)
    assert summary["error_rate"] == pytest.approx(1 / 6)


def test_summarize_timings_with_no_runs_is_zeroed() -> None:
    summary = _summarize_timings([], error_count=0)
    assert summary["count"] == 0
    assert summary["errors"] == 0
    assert summary["mean_ms"] == 0.0
    assert summary["p50_ms"] == 0.0
    assert summary["p95_ms"] == 0.0
    assert summary["error_rate"] == 0.0


def test_summarize_timings_all_errors_has_100_percent_error_rate() -> None:
    summary = _summarize_timings([], error_count=3)
    assert summary["count"] == 0
    assert summary["errors"] == 3
    assert summary["error_rate"] == pytest.approx(1.0)


def test_corpus_directory_exists_and_has_six_categories() -> None:
    assert BENCHMARK_CORPUS_DIR.exists(), BENCHMARK_CORPUS_DIR
    payload = list_benchmark_corpus_payload()
    names = {entry["category"] for entry in payload["categories"]}
    assert {"math", "science", "arts", "entertainment", "technology", "nonsense"} <= names


def test_corpus_payload_carries_prompts_with_ids() -> None:
    payload = list_benchmark_corpus_payload()
    for entry in payload["categories"]:
        assert entry["prompt_count"] >= 5
        assert isinstance(entry["description"], str) and entry["description"]
        for prompt in entry["prompts"]:
            assert prompt["id"] and isinstance(prompt["id"], str)
            assert isinstance(prompt["prompt"], str)


def test_corpus_files_on_disk_match_declared_category() -> None:
    """Every corpus JSON file must declare a ``category`` that matches its filename."""
    for path in sorted(BENCHMARK_CORPUS_DIR.glob("*.json")):
        import json
        data = json.loads(path.read_text())
        assert data["category"] == path.stem
        assert isinstance(data["prompts"], list) and data["prompts"]


def test_grade_output_without_expected_is_ungraded() -> None:
    result = _grade_output("anything", None)
    assert result == {"graded": False, "correct": None, "matches": [], "min_match": 0}


def test_grade_output_matches_single_keyword_case_insensitive() -> None:
    result = _grade_output(
        "Shakespeare wrote Hamlet.",
        {"any_of": ["shakespeare"]},
    )
    assert result["graded"] is True
    assert result["correct"] is True
    assert result["matches"] == ["shakespeare"]
    assert result["min_match"] == 1


def test_grade_output_requires_min_match_across_keywords() -> None:
    expected = {"any_of": ["crust", "mantle", "core"], "min_match": 3}
    partial = _grade_output("Crust and the mantle are layers.", expected)
    assert partial["correct"] is False
    assert set(partial["matches"]) == {"crust", "mantle"}

    full = _grade_output("The crust, mantle, and core.", expected)
    assert full["correct"] is True
    assert set(full["matches"]) == {"crust", "mantle", "core"}


def test_grade_output_empty_output_is_incorrect_when_graded() -> None:
    result = _grade_output("", {"any_of": ["anything"]})
    assert result["graded"] is True
    assert result["correct"] is False
    assert result["matches"] == []


def test_summarize_grades_ignores_ungraded_runs() -> None:
    runs = [
        {"graded": True, "correct": True},
        {"graded": True, "correct": False},
        {"graded": False, "correct": None},
        {"graded": True, "correct": True},
    ]
    summary = _summarize_grades(runs)
    assert summary["graded_count"] == 3
    assert summary["correct_count"] == 2
    assert summary["accuracy_rate"] == pytest.approx(2 / 3)


def test_summarize_grades_with_no_graded_runs_is_zeroed() -> None:
    runs = [{"graded": False, "correct": None}]
    summary = _summarize_grades(runs)
    assert summary["graded_count"] == 0
    assert summary["correct_count"] == 0
    assert summary["accuracy_rate"] == 0.0
