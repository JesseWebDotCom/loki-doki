from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Phase1BenchmarkCase:
    name: str
    message: str


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(float(v) for v in values)
    pos = (len(ordered) - 1) * q
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    weight = pos - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def summarize_latency_runs(runs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        buckets.setdefault(run["lane"], []).append(run)

    summary: dict[str, dict[str, float]] = {}
    for lane, lane_runs in buckets.items():
        end_to_end = [float(r["end_to_end_ms"]) for r in lane_runs]
        ttft = [float(r["ttft_ms"]) for r in lane_runs]
        summary[lane] = {
            "count": len(lane_runs),
            "p50_end_to_end_ms": _percentile(end_to_end, 0.50),
            "p95_end_to_end_ms": _percentile(end_to_end, 0.95),
            "p50_ttft_ms": _percentile(ttft, 0.50),
            "p95_ttft_ms": _percentile(ttft, 0.95),
        }

    all_end_to_end = [float(r["end_to_end_ms"]) for r in runs]
    all_ttft = [float(r["ttft_ms"]) for r in runs]
    summary["overall"] = {
        "count": len(runs),
        "p50_end_to_end_ms": _percentile(all_end_to_end, 0.50),
        "p95_end_to_end_ms": _percentile(all_end_to_end, 0.95),
        "p50_ttft_ms": _percentile(all_ttft, 0.50),
        "p95_ttft_ms": _percentile(all_ttft, 0.95),
    }
    return summary


async def run_phase1_chat_path_benchmark(
    *,
    client,
    memory,
    user_id: int,
    cases: list[Phase1BenchmarkCase],
    iterations: int = 3,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, float]]]:
    runs: list[dict[str, Any]] = []

    for _ in range(iterations):
        for case in cases:
            started = time.perf_counter()
            first_token_ms: float | None = None
            session_id: int | None = None
            synthesis_seen = False

            async with client.stream(
                "POST",
                "/api/v1/chat",
                json={"message": case.message},
                headers={"Accept": "text/event-stream"},
            ) as response:
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    event = json.loads(line[6:])
                    if event.get("phase") == "session":
                        session_id = int(event["data"]["session_id"])
                    if event.get("phase") != "synthesis":
                        continue
                    if event.get("status") in ("streaming", "done") and not synthesis_seen:
                        synthesis_seen = True
                        first_token_ms = (time.perf_counter() - started) * 1000.0

            end_to_end_ms = (time.perf_counter() - started) * 1000.0
            if first_token_ms is None:
                first_token_ms = end_to_end_ms
            if session_id is None:
                raise AssertionError(f"session event missing for benchmark case {case.name}")

            traces = await memory.list_chat_traces(user_id, session_id=session_id, limit=1)
            if not traces:
                raise AssertionError(f"missing trace for benchmark case {case.name}")
            lane = traces[0]["response_lane_actual"]

            runs.append({
                **asdict(case),
                "session_id": session_id,
                "lane": lane,
                "end_to_end_ms": end_to_end_ms,
                "ttft_ms": first_token_ms,
            })

    return runs, summarize_latency_runs(runs)
