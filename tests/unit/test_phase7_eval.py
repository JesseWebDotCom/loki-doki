"""Phase 7 unit tests: experiment evaluation and analysis.

Tests the eval module's ability to parse traces, compute per-arm
metrics, determine winners, and analyze fact telemetry — all with
synthetic data so we don't need a live database.
"""
from __future__ import annotations

import json

import pytest

from lokidoki.core.experiment_eval import (
    ArmStats,
    ExperimentReport,
    evaluate_experiment,
    evaluate_fact_telemetry,
    format_report,
    _percentile,
)


def _make_trace(
    *,
    memory_format_arm: str = "control",
    reranker_arm: str = "control",
    synthesis_ms: float = 500.0,
    routing_ms: float = 50.0,
    injected_facts: int = 2,
    retrieved_facts: int = 5,
    lane: str = "full_synthesis",
) -> dict:
    """Build a synthetic trace dict matching the orchestrator's shape."""
    facts_by_bucket = {
        "working_context": [{"id": i, "value": f"fact_{i}"} for i in range(injected_facts)],
        "semantic_profile": [],
        "relational_graph": [],
        "episodic_threads": [],
    }
    candidates_by_bucket = {
        "working_context": [{"id": i, "value": f"cand_{i}"} for i in range(retrieved_facts)],
        "semantic_profile": [],
        "relational_graph": [],
        "episodic_threads": [],
    }
    return {
        "selected_injected_memories_json": {
            "facts_by_bucket": facts_by_bucket,
            "experiment_arms": {
                "memory_format_v1": memory_format_arm,
                "reranker_v1": reranker_arm,
            },
        },
        "retrieved_memory_candidates_json": {
            "facts_by_bucket": candidates_by_bucket,
        },
        "phase_latencies_json": {
            "synthesis": synthesis_ms,
            "routing": routing_ms,
        },
        "response_lane_actual": lane,
    }


class TestPercentile:
    def test_empty(self):
        assert _percentile([], 50) == 0.0

    def test_single_value(self):
        assert _percentile([100.0], 50) == 100.0

    def test_p50_median(self):
        assert _percentile([10, 20, 30, 40, 50], 50) == 30.0

    def test_p95_high(self):
        data = list(range(1, 101))
        p95 = _percentile(data, 95)
        assert 95 <= p95 <= 96


class TestEvaluateExperiment:
    def test_no_traces_returns_empty(self):
        report = evaluate_experiment([], "memory_format_v1")
        assert report.experiment_id == "memory_format_v1"
        assert len(report.arms) == 0

    def test_single_arm_counted(self):
        traces = [_make_trace(memory_format_arm="control") for _ in range(5)]
        report = evaluate_experiment(traces, "memory_format_v1")
        assert "control" in report.arms
        assert report.arms["control"].turn_count == 5

    def test_two_arms_counted(self):
        traces = (
            [_make_trace(memory_format_arm="control") for _ in range(3)]
            + [_make_trace(memory_format_arm="warm") for _ in range(7)]
        )
        report = evaluate_experiment(traces, "memory_format_v1")
        assert report.arms["control"].turn_count == 3
        assert report.arms["warm"].turn_count == 7

    def test_latency_aggregation(self):
        traces = [
            _make_trace(memory_format_arm="control", synthesis_ms=100),
            _make_trace(memory_format_arm="control", synthesis_ms=200),
            _make_trace(memory_format_arm="control", synthesis_ms=300),
        ]
        report = evaluate_experiment(traces, "memory_format_v1")
        stats = report.arms["control"]
        assert stats.p50_latency == 200.0
        assert len(stats.latencies_ms) == 3

    def test_injection_rate(self):
        traces = [
            _make_trace(memory_format_arm="control", injected_facts=2, retrieved_facts=10),
            _make_trace(memory_format_arm="control", injected_facts=3, retrieved_facts=10),
        ]
        report = evaluate_experiment(traces, "memory_format_v1")
        stats = report.arms["control"]
        assert stats.injection_rate == pytest.approx(5.0 / 20.0, abs=0.01)

    def test_lane_distribution(self):
        traces = [
            _make_trace(memory_format_arm="control", lane="full_synthesis"),
            _make_trace(memory_format_arm="control", lane="social_ack"),
            _make_trace(memory_format_arm="control", lane="full_synthesis"),
        ]
        report = evaluate_experiment(traces, "memory_format_v1")
        lanes = report.arms["control"].lane_counts
        assert lanes["full_synthesis"] == 2
        assert lanes["social_ack"] == 1

    def test_pre_phase7_traces_skipped(self):
        """Traces without experiment_arms are silently skipped."""
        traces = [
            {"selected_injected_memories_json": {"facts_by_bucket": {}},
             "retrieved_memory_candidates_json": {},
             "phase_latencies_json": {},
             "response_lane_actual": "full_synthesis"},
        ]
        report = evaluate_experiment(traces, "memory_format_v1")
        assert len(report.arms) == 0

    def test_json_string_fields_parsed(self):
        """Traces may have JSON strings instead of dicts (from DB)."""
        trace = _make_trace(memory_format_arm="warm")
        # Simulate DB serialization
        trace["selected_injected_memories_json"] = json.dumps(
            trace["selected_injected_memories_json"]
        )
        trace["phase_latencies_json"] = json.dumps(
            trace["phase_latencies_json"]
        )
        trace["retrieved_memory_candidates_json"] = json.dumps(
            trace["retrieved_memory_candidates_json"]
        )
        report = evaluate_experiment([trace], "memory_format_v1")
        assert report.arms["warm"].turn_count == 1

    def test_reranker_experiment(self):
        traces = (
            [_make_trace(reranker_arm="control", routing_ms=30) for _ in range(5)]
            + [_make_trace(reranker_arm="reranker", routing_ms=80) for _ in range(5)]
        )
        report = evaluate_experiment(traces, "reranker_v1")
        assert report.arms["control"].p50_routing_latency == 30.0
        assert report.arms["reranker"].p50_routing_latency == 80.0


class TestJudgment:
    def test_insufficient_data_no_winner(self):
        traces = (
            [_make_trace(memory_format_arm="control") for _ in range(3)]
            + [_make_trace(memory_format_arm="warm") for _ in range(3)]
        )
        report = evaluate_experiment(traces, "memory_format_v1")
        assert report.winner == ""
        assert "insufficient" in report.reason

    def test_clear_latency_winner(self):
        traces = (
            [_make_trace(memory_format_arm="control", synthesis_ms=200) for _ in range(15)]
            + [_make_trace(memory_format_arm="warm", synthesis_ms=400) for _ in range(15)]
        )
        report = evaluate_experiment(traces, "memory_format_v1")
        assert report.winner == "control"

    def test_reranker_too_slow(self):
        traces = (
            [_make_trace(reranker_arm="control", synthesis_ms=200) for _ in range(15)]
            + [_make_trace(reranker_arm="reranker", synthesis_ms=500) for _ in range(15)]
        )
        report = evaluate_experiment(traces, "reranker_v1")
        assert report.winner == "control"
        assert "expensive" in report.reason


class TestFactTelemetry:
    def test_empty_telemetry(self):
        stats = evaluate_fact_telemetry([])
        assert stats.total_facts_tracked == 0
        assert stats.injection_rate == 0.0

    def test_basic_counts(self):
        rows = [
            {"fact_id": 1, "retrieve_count": 10, "inject_count": 3,
             "subject": "self", "predicate": "likes", "value": "coffee"},
            {"fact_id": 2, "retrieve_count": 5, "inject_count": 0,
             "subject": "self", "predicate": "likes", "value": "tea"},
        ]
        stats = evaluate_fact_telemetry(rows)
        assert stats.total_facts_tracked == 2
        assert stats.total_retrievals == 15
        assert stats.total_injections == 3
        assert stats.injection_rate == pytest.approx(3.0 / 15.0, abs=0.01)

    def test_dead_facts_identified(self):
        rows = [
            {"fact_id": 1, "retrieve_count": 10, "inject_count": 0,
             "subject": "self", "predicate": "likes", "value": "old hobby"},
            {"fact_id": 2, "retrieve_count": 3, "inject_count": 0,
             "subject": "self", "predicate": "likes", "value": "recent"},
        ]
        stats = evaluate_fact_telemetry(rows)
        # Only fact 1 qualifies (>= 5 retrieves, 0 injects)
        assert len(stats.dead_facts) == 1
        assert stats.dead_facts[0]["fact_id"] == 1

    def test_top_injected_sorted(self):
        rows = [
            {"fact_id": 1, "retrieve_count": 5, "inject_count": 1,
             "subject": "s", "predicate": "p", "value": "low"},
            {"fact_id": 2, "retrieve_count": 5, "inject_count": 10,
             "subject": "s", "predicate": "p", "value": "high"},
        ]
        stats = evaluate_fact_telemetry(rows)
        assert stats.top_injected[0]["fact_id"] == 2

    def test_realistic_fact_values(self):
        """Real-world-style fact data."""
        rows = [
            {"fact_id": 1, "retrieve_count": 20, "inject_count": 8,
             "subject": "self", "predicate": "likes",
             "value": "hiking in the mountains on weekends"},
            {"fact_id": 2, "retrieve_count": 15, "inject_count": 0,
             "subject": "Artie", "predicate": "is_brother_of",
             "value": "the user"},
            {"fact_id": 3, "retrieve_count": 2, "inject_count": 2,
             "subject": "self", "predicate": "mentioned",
             "value": "im so stressed rn about work"},
        ]
        stats = evaluate_fact_telemetry(rows)
        assert stats.total_facts_tracked == 3
        assert len(stats.dead_facts) == 1  # Artie fact never injected


class TestFormatReport:
    def test_produces_nonempty_output(self):
        mem = ExperimentReport(experiment_id="memory_format_v1")
        rer = ExperimentReport(experiment_id="reranker_v1")
        tel = evaluate_fact_telemetry([])
        text = format_report(mem, rer, tel)
        assert "PHASE 7 EXPERIMENT EVALUATION REPORT" in text
        assert "memory_format_v1" in text
        assert "reranker_v1" in text

    def test_includes_arm_stats(self):
        mem = ExperimentReport(
            experiment_id="memory_format_v1",
            arms={
                "control": ArmStats(
                    arm="control", turn_count=10,
                    latencies_ms=[100, 200, 300],
                    injected_fact_counts=[2, 3],
                    retrieved_fact_counts=[5, 5],
                    lane_counts={"full_synthesis": 10},
                ),
            },
        )
        rer = ExperimentReport(experiment_id="reranker_v1")
        tel = evaluate_fact_telemetry([])
        text = format_report(mem, rer, tel)
        assert "10 turns" in text
        assert "p50=" in text
        assert "Injection rate" in text
