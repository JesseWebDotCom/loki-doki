"""Warm the local Valhalla sidecar, fire N routes, report latency + RSS.

Samples origin/destination pairs uniformly from an installed region's
bbox and posts them to ``POST /api/v1/maps/route``. After every run,
prints p50 / p95 / p99 latency and peak RSS so we can track the Pi-5
targets from ``docs/roadmap/offline-maps/chunk-6-routing-backend.md``:

  - State-scale region  (CT): p95 < 200 ms, RSS < 2 GB
  - Country-scale region (US contig): p95 < 1.5 s, RSS < 6 GB

Usage:

  uv run python scripts/bench_routing.py --region us-ct --samples 50
"""
from __future__ import annotations

import argparse
import asyncio
import random
import statistics
import sys
import time
from dataclasses import dataclass

import httpx


@dataclass(slots=True)
class _Sample:
    o_lat: float
    o_lon: float
    d_lat: float
    d_lon: float


def _sample_pairs(bbox: tuple[float, float, float, float], n: int, seed: int) -> list[_Sample]:
    rng = random.Random(seed)
    min_lon, min_lat, max_lon, max_lat = bbox
    out: list[_Sample] = []
    for _ in range(n):
        out.append(_Sample(
            o_lat=rng.uniform(min_lat, max_lat),
            o_lon=rng.uniform(min_lon, max_lon),
            d_lat=rng.uniform(min_lat, max_lat),
            d_lon=rng.uniform(min_lon, max_lon),
        ))
    return out


async def _fetch_region(client: httpx.AsyncClient, base_url: str, region_id: str):
    resp = await client.get(f"{base_url}/api/v1/maps/catalog/flat")
    resp.raise_for_status()
    for region in resp.json()["regions"]:
        if region["region_id"] == region_id:
            return region
    raise SystemExit(f"region {region_id} not in catalog")


async def _post_route(client: httpx.AsyncClient, base_url: str, sample: _Sample) -> tuple[float, bool]:
    body = {
        "origin": {"lat": sample.o_lat, "lon": sample.o_lon},
        "destination": {"lat": sample.d_lat, "lon": sample.d_lon},
        "profile": "auto",
    }
    t0 = time.perf_counter()
    resp = await client.post(f"{base_url}/api/v1/maps/route", json=body)
    elapsed = (time.perf_counter() - t0) * 1000.0
    return elapsed, resp.status_code == 200


def _peak_rss_mb() -> float:
    try:
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except (ImportError, AttributeError):  # pragma: no cover — non-POSIX
        return float("nan")


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, int(round(pct / 100.0 * (len(ordered) - 1)))))
    return ordered[k]


async def _run(args) -> int:
    async with httpx.AsyncClient(timeout=30.0) as client:
        region = await _fetch_region(client, args.base_url, args.region)
        bbox = tuple(region["bbox"])
        samples = _sample_pairs(bbox, args.samples, args.seed)

        # Warm the sidecar with one throwaway request.
        await _post_route(client, args.base_url, samples[0])

        latencies: list[float] = []
        failures = 0
        for sample in samples:
            elapsed_ms, ok = await _post_route(client, args.base_url, sample)
            if ok:
                latencies.append(elapsed_ms)
            else:
                failures += 1

    rss_mb = _peak_rss_mb()
    print(f"region           {args.region}")
    print(f"samples          {len(latencies)} / {args.samples}")
    print(f"failures         {failures}")
    if latencies:
        print(f"p50 latency ms   {_percentile(latencies, 50):.1f}")
        print(f"p95 latency ms   {_percentile(latencies, 95):.1f}")
        print(f"p99 latency ms   {_percentile(latencies, 99):.1f}")
        print(f"mean latency ms  {statistics.fmean(latencies):.1f}")
    print(f"peak RSS MB      {rss_mb:.1f}")
    return 0 if latencies else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True, help="installed region id (e.g. us-ct)")
    parser.add_argument("--samples", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
