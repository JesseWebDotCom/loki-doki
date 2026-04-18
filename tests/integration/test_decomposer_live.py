"""Opt-in live-LLM test — measures real-world decomposer accuracy.

Skipped by default because it:
- Requires a running LLM endpoint (mlx-lm / llama-server / ollama)
- Takes 10-30 seconds to run (each query is a real model call)
- Has a failure mode that's non-deterministic (model temperature, etc.)

Run explicitly with::

    LOKI_LLM_ENABLED=1 python -m pytest tests/integration/test_decomposer_live.py -v -s

The test reports per-query latency + whether the real model emits the
capability_need the routing logic expects. This is the only test that
measures production accuracy — every other test uses a mocked oracle
decomposer to validate the scoring/boost plumbing.
"""
from __future__ import annotations

import asyncio
import os
import unittest

from lokidoki.orchestrator.core.config import CONFIG

# ``CONFIG.llm_enabled`` auto-detects pytest and defaults to False to
# keep the hermetic test suite fast. This live test overrides that.
_LIVE_ENABLED = os.environ.get("LOKI_LLM_ENABLED", "").strip().lower() in {"1", "true", "yes"}


# Queries paired with the capability_need an ideal decomposer should emit.
# Intentionally diverse across all enum values so we measure breadth.
LIVE_CORPUS: list[tuple[str, str]] = [
    ("my chest hurts", "medical"),
    ("max dose of ibuprofen", "medical"),
    ("how do i unclog a drain", "howto"),
    ("fix a running toilet", "howto"),
    ("population of sweden", "country_facts"),
    ("explain derivatives", "education"),
    ("systemd unit syntax", "technical_reference"),
    ("things to do in tokyo", "geographic"),
    ("is it raining tomorrow", "weather"),
    ("whats playing in theaters", "current_media"),
    ("mkbhd latest video", "youtube"),
    ("whens my sisters birthday", "people_lookup"),
    ("latest iphone release date", "web_search"),
    ("who was alan turing", "encyclopedic"),
    ("set a 10 minute timer", "timer_reminder"),
    ("remind me to feed the cat", "timer_reminder"),
    ("add dentist appointment tuesday", "calendar"),
    ("whats on my calendar today", "calendar"),
    ("how long to drive to portland", "navigation"),
    ("convert 30 miles to kilometers", "conversion"),
    ("text mom im running late", "messaging"),
    ("play some jazz", "music_control"),
    ("turn off the kitchen light", "device_control"),
    ("whats in the news today", "news"),
    ("hey whats up", "none"),
]


@unittest.skipUnless(
    _LIVE_ENABLED,
    "Set LOKI_LLM_ENABLED=1 to run live-LLM tests",
)
class TestDecomposerLive(unittest.TestCase):
    """Hit a real LLM endpoint and measure decomposer accuracy."""

    @classmethod
    def setUpClass(cls) -> None:
        """Flip CONFIG.llm_enabled on for this test class."""
        cls._original_enabled = CONFIG.llm_enabled
        object.__setattr__(CONFIG, "llm_enabled", True)

    @classmethod
    def tearDownClass(cls) -> None:
        object.__setattr__(CONFIG, "llm_enabled", cls._original_enabled)

    def test_endpoint_reachable(self):
        """Sanity check that the configured endpoint responds."""
        from lokidoki.orchestrator.decomposer.client import _call_fast_llm

        async def probe() -> str:
            return await _call_fast_llm("hello", "")

        try:
            text = asyncio.run(asyncio.wait_for(probe(), timeout=10.0))
        except asyncio.TimeoutError:
            self.skipTest(f"LLM endpoint {CONFIG.llm_endpoint} did not respond in 10s")
        except Exception as exc:  # noqa: BLE001 — surface transport as skip
            self.skipTest(f"LLM endpoint {CONFIG.llm_endpoint} unreachable: {exc}")
        self.assertTrue(text, "LLM returned empty response")

    def test_decomposer_accuracy_on_live_corpus(self):
        """Run the full corpus through the real decomposer."""
        from lokidoki.orchestrator.decomposer import decompose_for_routing
        from lokidoki.orchestrator.decomposer.cache import clear_cache

        clear_cache()  # ensure every query hits the LLM, not the cache

        correct = 0
        misses: list[tuple[str, str, str, float]] = []
        latencies: list[float] = []
        source_counts: dict[str, int] = {}

        for query, expected_need in LIVE_CORPUS:
            result = asyncio.run(decompose_for_routing(query))
            latencies.append(result.latency_ms)
            source_counts[result.source] = source_counts.get(result.source, 0) + 1
            if result.capability_need == expected_need:
                correct += 1
            else:
                misses.append(
                    (query, expected_need, result.capability_need, result.latency_ms),
                )

        total = len(LIVE_CORPUS)
        accuracy = correct / total
        avg_latency = sum(latencies) / total
        p95_latency = sorted(latencies)[int(total * 0.95)]

        print(f"\n[Live-LLM decomposer] model={CONFIG.llm_model} endpoint={CONFIG.llm_endpoint}")
        print(f"[Accuracy] {correct}/{total} = {accuracy:.1%}")
        print(f"[Latency] avg={avg_latency:.0f}ms p95={p95_latency:.0f}ms")
        print(f"[Sources] {source_counts}")
        for query, expected, actual, latency in misses:
            print(f"  MISS ({latency:.0f}ms): {query!r} expected={expected} got={actual}")

        # Floor: 70% accuracy. Anything below means the model is
        # choking on the prompt or the enum is too granular for it.
        self.assertGreaterEqual(
            accuracy, 0.70,
            f"Live decomposer accuracy {accuracy:.1%} below 70% floor. "
            "Check model quality or prompt clarity.",
        )

        # Timing floor: p95 under 1500ms on mac (Qwen3-8B MLX),
        # 3000ms on Pi hailo. The 3000ms ceiling catches regressions
        # like a runaway max_tokens or cold-start model loads.
        self.assertLess(
            p95_latency, 3000,
            f"Live decomposer p95 latency {p95_latency:.0f}ms exceeds 3000ms ceiling",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
