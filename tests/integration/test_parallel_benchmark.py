"""Phase 4 latency benchmark.

Demonstrates that the v2 orchestrator's per-chunk parallelism (route /
select / resolve / execute via ``asyncio.gather``) actually delivers a
measurable speedup when handlers are I/O-bound. We use sleep-based
handlers so the test is hermetic and deterministic.

The benchmark is **not** a microbenchmark — it's a regression guard.
If someone accidentally serializes the per-chunk fan-out, this test
will start failing because the parallel path stops being faster than
the simulated sequential one.
"""
from __future__ import annotations

import time
from typing import Any

import pytest

from lokidoki.orchestrator.core.pipeline import run_pipeline_async
from lokidoki.orchestrator.execution.executor import register_handler

# Each chunk's handler sleeps this long. With 3 chunks and full
# parallelism we expect ~1x SLEEP_S; with serial execution we'd expect
# ~3x SLEEP_S. We assert the speedup is at least ~1.8x to allow for
# event-loop / scheduling slack on slow CI.
SLEEP_S = 0.08


def _slow_greeting(payload):
    time.sleep(SLEEP_S)
    return {"output_text": "Hello."}


def _slow_spell(payload):
    time.sleep(SLEEP_S)
    return {"output_text": str(payload.get("resolved_target") or "")}


def _slow_time(payload):
    time.sleep(SLEEP_S)
    return {"output_text": "12:00 PM"}


@pytest.fixture(autouse=True)
def _install_slow_handlers():
    """Swap in sleep-based handlers, then restore the originals on teardown.

    The executor module's ``_HANDLER_REGISTRY`` is process-global, so we
    snapshot the real functions by reaching into the module — never via
    a lambda, because other tests rely on ``handler.__name__``.
    """
    from lokidoki.orchestrator.execution import executor as executor_module

    snapshot: dict[str, Any] = {}
    targets = (
        "core.greetings.reply",
        "core.dictionary.spell",
        "core.dictionary.spell_fallback",
        "core.time.get_local_time",
        "core.time.get_local_time_backup",
    )
    for handler_name in targets:
        snapshot[handler_name] = executor_module._BUILTIN_HANDLERS[handler_name]

    register_handler("core.greetings.reply", _slow_greeting)
    register_handler("core.dictionary.spell", _slow_spell)
    register_handler("core.dictionary.spell_fallback", _slow_spell)
    register_handler("core.time.get_local_time", _slow_time)
    register_handler("core.time.get_local_time_backup", _slow_time)

    yield

    for handler_name, original in snapshot.items():
        register_handler(handler_name, original)


@pytest.mark.anyio
async def test_pipeline_parallel_path_is_faster_than_simulated_sequential():
    utterance = "hello and how do you spell restaurant and what time is it"
    expected_chunks = 3

    # Warm up the spaCy model + MiniLM index so cold-start cost does not
    # contaminate the parallelism measurement.
    await run_pipeline_async("warmup")

    result = await run_pipeline_async(utterance)

    assert len(result.executions) == expected_chunks

    # The execute step is the one we parallelize. Compare its wall-clock
    # elapsed time (recorded in the trace) against the sum of per-chunk
    # handler timings — if asyncio.gather is doing its job, the wall
    # clock should be ~one handler, not three.
    execute_step = next(step for step in result.trace.steps if step.name == "execute")
    execute_wall_ms = execute_step.timing_ms
    chunk_timings_ms = [
        float(chunk["timing_ms"]) for chunk in execute_step.details["chunks"]
    ]
    serial_total_ms = sum(chunk_timings_ms)

    # Sanity: each handler did sleep at least most of SLEEP_S.
    assert all(timing >= SLEEP_S * 1000 * 0.7 for timing in chunk_timings_ms), (
        f"handlers did not sleep as expected: {chunk_timings_ms}"
    )

    # Wall clock for the execute step should be at most ~1.5x a single
    # sleep (real parallelism), never close to 3x.
    assert execute_wall_ms < SLEEP_S * 1000 * 1.8, (
        f"execute step wall-clock was {execute_wall_ms:.1f}ms; "
        f"expected < {SLEEP_S * 1000 * 1.8:.1f}ms — asyncio.gather may have regressed"
    )

    speedup = serial_total_ms / execute_wall_ms if execute_wall_ms else 0.0
    assert speedup > 1.8, (
        f"serial-vs-parallel speedup was only {speedup:.2f}x "
        f"(serial total {serial_total_ms:.1f}ms vs parallel wall {execute_wall_ms:.1f}ms); "
        f"expected > 1.8x for {expected_chunks} chunks"
    )
