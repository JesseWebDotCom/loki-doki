from lokidoki.evals.phase1 import summarize_latency_runs


def test_phase1_latency_summary_computes_lane_percentiles():
    runs = [
        {"lane": "social_ack", "end_to_end_ms": 10.0, "ttft_ms": 4.0},
        {"lane": "social_ack", "end_to_end_ms": 20.0, "ttft_ms": 6.0},
        {"lane": "full_synthesis", "end_to_end_ms": 50.0, "ttft_ms": 20.0},
        {"lane": "full_synthesis", "end_to_end_ms": 90.0, "ttft_ms": 40.0},
    ]

    summary = summarize_latency_runs(runs)

    assert summary["social_ack"]["count"] == 2
    assert summary["social_ack"]["p50_end_to_end_ms"] == 15.0
    assert summary["social_ack"]["p95_end_to_end_ms"] == 19.5
    assert summary["full_synthesis"]["p50_ttft_ms"] == 30.0
    assert summary["overall"]["count"] == 4

