"""Phase 7: experiment evaluation and analysis.

Pulls data from chat_traces and fact_telemetry to compare experiment
arms. Produces structured reports that can be printed or piped into
a downstream scoring system.

Metrics computed per experiment:

memory_format_v1:
  - turn count per arm
  - p50/p95 synthesis latency per arm
  - injected fact count per arm
  - memory injection rate (injected / retrieved)
  - lane distribution per arm

reranker_v1:
  - turn count per arm
  - p50/p95 end-to-end latency per arm
  - p50/p95 routing latency per arm (measures reranker overhead)
  - injected fact count per arm
  - unique facts injected per arm

fact telemetry:
  - inject/retrieve ratio distribution
  - most-retrieved vs most-injected facts
  - "dead" facts (retrieved but never injected)
"""
from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ArmStats:
    arm: str
    turn_count: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    routing_latencies_ms: list[float] = field(default_factory=list)
    injected_fact_counts: list[int] = field(default_factory=list)
    retrieved_fact_counts: list[int] = field(default_factory=list)
    lane_counts: dict[str, int] = field(default_factory=dict)

    @property
    def p50_latency(self) -> float:
        return _percentile(self.latencies_ms, 50)

    @property
    def p95_latency(self) -> float:
        return _percentile(self.latencies_ms, 95)

    @property
    def p50_routing_latency(self) -> float:
        return _percentile(self.routing_latencies_ms, 50)

    @property
    def p95_routing_latency(self) -> float:
        return _percentile(self.routing_latencies_ms, 95)

    @property
    def mean_injected_facts(self) -> float:
        return statistics.mean(self.injected_fact_counts) if self.injected_fact_counts else 0.0

    @property
    def mean_retrieved_facts(self) -> float:
        return statistics.mean(self.retrieved_fact_counts) if self.retrieved_fact_counts else 0.0

    @property
    def injection_rate(self) -> float:
        total_retrieved = sum(self.retrieved_fact_counts)
        total_injected = sum(self.injected_fact_counts)
        if total_retrieved == 0:
            return 0.0
        return total_injected / total_retrieved


@dataclass
class FactTelemetryStats:
    total_facts_tracked: int = 0
    total_retrievals: int = 0
    total_injections: int = 0
    injection_rate: float = 0.0
    top_retrieved: list[dict] = field(default_factory=list)
    top_injected: list[dict] = field(default_factory=list)
    dead_facts: list[dict] = field(default_factory=list)


@dataclass
class ExperimentReport:
    experiment_id: str
    arms: dict[str, ArmStats] = field(default_factory=dict)
    winner: str = ""
    reason: str = ""


def _percentile(data: list[float], pct: int) -> float:
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * pct / 100.0
    f = int(k)
    c = f + 1
    if c >= len(s):
        return s[-1]
    return s[f] + (k - f) * (s[c] - s[f])


def _parse_json_field(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _count_injected_facts(selected: dict) -> int:
    facts_by_bucket = selected.get("facts_by_bucket") or {}
    count = 0
    for rows in facts_by_bucket.values():
        if isinstance(rows, list):
            count += len(rows)
    return count


def _count_retrieved_facts(candidates: dict) -> int:
    facts_by_bucket = candidates.get("facts_by_bucket") or {}
    count = 0
    for rows in facts_by_bucket.values():
        if isinstance(rows, list):
            count += len(rows)
    return count


def evaluate_experiment(
    traces: list[dict],
    experiment_id: str,
) -> ExperimentReport:
    """Evaluate a single experiment across all traces.

    Each trace's ``selected_injected_memories_json`` contains an
    ``experiment_arms`` dict mapping experiment_id -> arm. Traces
    without this field are skipped (pre-Phase-7 data).
    """
    report = ExperimentReport(experiment_id=experiment_id)

    for trace in traces:
        selected = _parse_json_field(
            trace.get("selected_injected_memories_json")
        )
        arms = selected.get("experiment_arms") or {}
        arm = arms.get(experiment_id)
        if arm is None:
            continue

        if arm not in report.arms:
            report.arms[arm] = ArmStats(arm=arm)
        stats = report.arms[arm]
        stats.turn_count += 1

        # Latencies
        latencies = _parse_json_field(trace.get("phase_latencies_json"))
        synthesis_ms = float(latencies.get("synthesis", 0.0) or 0.0)
        routing_ms = float(latencies.get("routing", 0.0) or 0.0)
        if synthesis_ms > 0:
            stats.latencies_ms.append(synthesis_ms)
        if routing_ms > 0:
            stats.routing_latencies_ms.append(routing_ms)

        # Fact counts
        candidates = _parse_json_field(
            trace.get("retrieved_memory_candidates_json")
        )
        stats.injected_fact_counts.append(_count_injected_facts(selected))
        stats.retrieved_fact_counts.append(_count_retrieved_facts(candidates))

        # Lane distribution
        lane = trace.get("response_lane_actual") or "unknown"
        stats.lane_counts[lane] = stats.lane_counts.get(lane, 0) + 1

    # Determine winner based on experiment type
    if len(report.arms) >= 2:
        arm_list = sorted(report.arms.values(), key=lambda a: a.turn_count, reverse=True)
        if experiment_id == "memory_format_v1":
            report.winner, report.reason = _judge_memory_format(arm_list)
        elif experiment_id == "reranker_v1":
            report.winner, report.reason = _judge_reranker(arm_list)

    return report


def _judge_memory_format(arms: list[ArmStats]) -> tuple[str, str]:
    """Compare memory format arms. Winner has lower latency without
    sacrificing injection quality."""
    if len(arms) < 2:
        return "", "insufficient arms"
    a, b = arms[0], arms[1]
    if a.turn_count < 10 or b.turn_count < 10:
        return "", f"insufficient data ({a.arm}={a.turn_count}, {b.arm}={b.turn_count} turns)"

    latency_diff = a.p50_latency - b.p50_latency
    injection_diff = a.mean_injected_facts - b.mean_injected_facts

    # Prefer lower latency if injection counts are similar
    if abs(injection_diff) < 0.5:
        if abs(latency_diff) < 50:
            return "", "no significant difference"
        winner = a.arm if latency_diff < 0 else b.arm
        return winner, f"lower p50 latency by {abs(latency_diff):.0f}ms with similar injection"

    # If injection differs, prefer higher injection rate
    winner = a.arm if a.injection_rate > b.injection_rate else b.arm
    return winner, f"higher injection rate ({max(a.injection_rate, b.injection_rate):.2f} vs {min(a.injection_rate, b.injection_rate):.2f})"


def _judge_reranker(arms: list[ArmStats]) -> tuple[str, str]:
    """Compare reranker arms. Winner has better injection rate
    without unacceptable latency regression."""
    if len(arms) < 2:
        return "", "insufficient arms"

    control = next((a for a in arms if a.arm == "control"), arms[0])
    reranker = next((a for a in arms if a.arm == "reranker"), arms[1])

    if control.turn_count < 10 or reranker.turn_count < 10:
        return "", f"insufficient data (control={control.turn_count}, reranker={reranker.turn_count} turns)"

    latency_overhead = reranker.p50_latency - control.p50_latency
    injection_improvement = reranker.injection_rate - control.injection_rate

    # Reranker must not add >200ms p50 overhead
    if latency_overhead > 200:
        return "control", f"reranker adds {latency_overhead:.0f}ms p50 latency — too expensive"

    if injection_improvement > 0.05:
        return "reranker", f"injection rate +{injection_improvement:.2f} with {latency_overhead:.0f}ms overhead"

    if injection_improvement < -0.05:
        return "control", f"reranker hurts injection rate by {abs(injection_improvement):.2f}"

    return "", "no significant difference"


def evaluate_fact_telemetry(
    telemetry_rows: list[dict],
) -> FactTelemetryStats:
    """Analyze fact-level telemetry for usefulness correlation."""
    stats = FactTelemetryStats()
    stats.total_facts_tracked = len(telemetry_rows)

    for row in telemetry_rows:
        rc = int(row.get("retrieve_count", 0) or 0)
        ic = int(row.get("inject_count", 0) or 0)
        stats.total_retrievals += rc
        stats.total_injections += ic

    if stats.total_retrievals > 0:
        stats.injection_rate = stats.total_injections / stats.total_retrievals

    # Top retrieved (most popular candidates)
    by_retrieve = sorted(telemetry_rows, key=lambda r: int(r.get("retrieve_count", 0) or 0), reverse=True)
    stats.top_retrieved = [
        {
            "fact_id": r.get("fact_id"),
            "subject": r.get("subject", ""),
            "predicate": r.get("predicate", ""),
            "value": r.get("value", ""),
            "retrieve_count": int(r.get("retrieve_count", 0) or 0),
            "inject_count": int(r.get("inject_count", 0) or 0),
        }
        for r in by_retrieve[:10]
    ]

    # Top injected (most useful)
    by_inject = sorted(telemetry_rows, key=lambda r: int(r.get("inject_count", 0) or 0), reverse=True)
    stats.top_injected = [
        {
            "fact_id": r.get("fact_id"),
            "subject": r.get("subject", ""),
            "predicate": r.get("predicate", ""),
            "value": r.get("value", ""),
            "retrieve_count": int(r.get("retrieve_count", 0) or 0),
            "inject_count": int(r.get("inject_count", 0) or 0),
        }
        for r in by_inject[:10]
    ]

    # Dead facts: retrieved >= 5 times but never injected
    stats.dead_facts = [
        {
            "fact_id": r.get("fact_id"),
            "subject": r.get("subject", ""),
            "value": r.get("value", ""),
            "retrieve_count": int(r.get("retrieve_count", 0) or 0),
        }
        for r in telemetry_rows
        if int(r.get("retrieve_count", 0) or 0) >= 5
        and int(r.get("inject_count", 0) or 0) == 0
    ]

    return stats


def format_report(
    memory_format_report: ExperimentReport,
    reranker_report: ExperimentReport,
    telemetry_stats: FactTelemetryStats,
) -> str:
    """Render a human-readable eval report."""
    lines: list[str] = []
    lines.append("=" * 60)
    lines.append("PHASE 7 EXPERIMENT EVALUATION REPORT")
    lines.append("=" * 60)

    for report in (memory_format_report, reranker_report):
        lines.append("")
        lines.append(f"--- {report.experiment_id} ---")
        if not report.arms:
            lines.append("  No data yet.")
            continue

        for arm_name, stats in sorted(report.arms.items()):
            lines.append(f"  [{arm_name}] {stats.turn_count} turns")
            lines.append(f"    Synthesis latency: p50={stats.p50_latency:.0f}ms  p95={stats.p95_latency:.0f}ms")
            if stats.routing_latencies_ms:
                lines.append(f"    Routing latency:   p50={stats.p50_routing_latency:.0f}ms  p95={stats.p95_routing_latency:.0f}ms")
            lines.append(f"    Avg injected facts: {stats.mean_injected_facts:.1f}")
            lines.append(f"    Avg retrieved facts: {stats.mean_retrieved_facts:.1f}")
            lines.append(f"    Injection rate: {stats.injection_rate:.2f}")
            if stats.lane_counts:
                lanes = ", ".join(f"{k}={v}" for k, v in sorted(stats.lane_counts.items()))
                lines.append(f"    Lanes: {lanes}")

        if report.winner:
            lines.append(f"  WINNER: {report.winner} — {report.reason}")
        elif report.reason:
            lines.append(f"  VERDICT: {report.reason}")

    lines.append("")
    lines.append("--- fact telemetry ---")
    lines.append(f"  Facts tracked: {telemetry_stats.total_facts_tracked}")
    lines.append(f"  Total retrievals: {telemetry_stats.total_retrievals}")
    lines.append(f"  Total injections: {telemetry_stats.total_injections}")
    lines.append(f"  Overall injection rate: {telemetry_stats.injection_rate:.2f}")

    if telemetry_stats.top_injected:
        lines.append("  Top injected facts:")
        for f in telemetry_stats.top_injected[:5]:
            lines.append(
                f"    #{f['fact_id']} {f['subject']} {f['value'][:40]}"
                f" (ret={f['retrieve_count']}, inj={f['inject_count']})"
            )

    if telemetry_stats.dead_facts:
        lines.append(f"  Dead facts (retrieved but never injected): {len(telemetry_stats.dead_facts)}")
        for f in telemetry_stats.dead_facts[:5]:
            lines.append(
                f"    #{f['fact_id']} {f['subject']} {f['value'][:40]}"
                f" (ret={f['retrieve_count']})"
            )

    lines.append("")
    lines.append("=" * 60)
    return "\n".join(lines)
