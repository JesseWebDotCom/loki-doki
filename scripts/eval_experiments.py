#!/usr/bin/env python3
"""Evaluate Phase 7 A/B experiments from the live database.

Usage:
    uv run python scripts/eval_experiments.py
    uv run python scripts/eval_experiments.py --db data/lokidoki.db
    uv run python scripts/eval_experiments.py --json

Reads chat_traces and fact_telemetry, computes per-arm metrics,
and prints a summary report. Use --json for machine-readable output.
"""
from __future__ import annotations

import argparse
import json
import sys

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core import memory_sql as sql
from lokidoki.core.experiment_eval import (
    evaluate_experiment,
    evaluate_fact_telemetry,
    format_report,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Phase 7 experiments")
    parser.add_argument(
        "--db", default="data/lokidoki.db",
        help="Path to the SQLite database (default: data/lokidoki.db)",
    )
    parser.add_argument(
        "--limit", type=int, default=10000,
        help="Max traces to analyze (default: 10000)",
    )
    parser.add_argument(
        "--json", action="store_true", dest="json_output",
        help="Output as JSON instead of human-readable text",
    )
    args = parser.parse_args()

    conn, _ = open_and_migrate(args.db)

    # Load traces
    raw_traces = sql.list_all_chat_traces(conn, limit=args.limit)
    traces = []
    for row in raw_traces:
        item = dict(row)
        for key in (
            "decomposition_json",
            "referent_resolution_json",
            "retrieved_memory_candidates_json",
            "selected_injected_memories_json",
            "skill_results_json",
            "prompt_sizes_json",
            "response_spec_shadow_json",
            "phase_latencies_json",
        ):
            raw = item.get(key) or "{}"
            if isinstance(raw, str):
                try:
                    item[key] = json.loads(raw)
                except json.JSONDecodeError:
                    item[key] = {}
        traces.append(item)

    # Load fact telemetry
    raw_telemetry = sql.list_fact_telemetry_all(conn, limit=args.limit)
    telemetry = [dict(r) for r in raw_telemetry]

    conn.close()

    # Evaluate
    mem_report = evaluate_experiment(traces, "memory_format_v1")
    reranker_report = evaluate_experiment(traces, "reranker_v1")
    telemetry_stats = evaluate_fact_telemetry(telemetry)

    if args.json_output:
        output = {
            "memory_format_v1": {
                "arms": {
                    name: {
                        "turn_count": s.turn_count,
                        "p50_latency_ms": round(s.p50_latency, 1),
                        "p95_latency_ms": round(s.p95_latency, 1),
                        "mean_injected_facts": round(s.mean_injected_facts, 2),
                        "mean_retrieved_facts": round(s.mean_retrieved_facts, 2),
                        "injection_rate": round(s.injection_rate, 3),
                        "lane_counts": s.lane_counts,
                    }
                    for name, s in mem_report.arms.items()
                },
                "winner": mem_report.winner,
                "reason": mem_report.reason,
            },
            "reranker_v1": {
                "arms": {
                    name: {
                        "turn_count": s.turn_count,
                        "p50_latency_ms": round(s.p50_latency, 1),
                        "p95_latency_ms": round(s.p95_latency, 1),
                        "p50_routing_latency_ms": round(s.p50_routing_latency, 1),
                        "p95_routing_latency_ms": round(s.p95_routing_latency, 1),
                        "mean_injected_facts": round(s.mean_injected_facts, 2),
                        "injection_rate": round(s.injection_rate, 3),
                    }
                    for name, s in reranker_report.arms.items()
                },
                "winner": reranker_report.winner,
                "reason": reranker_report.reason,
            },
            "fact_telemetry": {
                "total_facts_tracked": telemetry_stats.total_facts_tracked,
                "total_retrievals": telemetry_stats.total_retrievals,
                "total_injections": telemetry_stats.total_injections,
                "injection_rate": round(telemetry_stats.injection_rate, 3),
                "dead_facts_count": len(telemetry_stats.dead_facts),
                "top_injected": telemetry_stats.top_injected[:5],
            },
        }
        print(json.dumps(output, indent=2))
    else:
        print(format_report(mem_report, reranker_report, telemetry_stats))


if __name__ == "__main__":
    main()
