"""Multi-turn conversation script runner.

Replays scripted conversations through the full pipeline, carrying
session state across turns. Each turn can assert on routing, response
content, timing, memory usage, and goal inference.

A new conversation scenario = one new entry in
``tests/fixtures/conversation_scripts.json``. No code change needed.

Supported per-turn ``expect`` keys (all optional):

- Everything from ``test_regression_prompts.py``:
  ``fast_lane_matched``, ``capability``, ``chunk_count``,
  ``response_contains``, ``response_contains_all``, ``llm_used``,
  ``llm_reason``, ``subjects_contain``, ``resolved_person``,
  ``max_step_ms``, ``max_total_ms``, ``tone_signal``,
  ``interaction_signal``

- New multi-turn assertions:
  ``resolved_target_contains`` (str) — at least one resolution's
  resolved_target contains this substring (case-insensitive).
  ``likely_goal`` (str) — the inferred goal matches this value.
  ``memory_slot_contains`` (dict[str, str]) — for each key/value pair,
  the named memory slot's text contains the value substring.

Per-script keys:

- ``seed_memory`` (list[dict]) — facts to pre-seed into the memory
  store before the first turn. Each dict has subject/predicate/value
  (and optional confidence). Uses pop-culture names per CLAUDE.md.
- ``known_tuning_gap`` (bool) — if true, the script is xfail'd.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from lokidoki.orchestrator.core.pipeline import run_pipeline_async
from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.store import MemoryStore


_FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "conversation_scripts.json"


def _load_scripts() -> list[dict[str, Any]]:
    payload = json.loads(_FIXTURE_PATH.read_text())
    return list(payload.get("scripts") or [])


_SCRIPTS = _load_scripts()


def _warm_pipeline_once() -> None:
    """Warm spaCy + fastembed so timing assertions measure steady state."""

    async def _warm() -> None:
        await run_pipeline_async("hello")
        await run_pipeline_async("what time is the new mario movie playing")

    asyncio.run(_warm())


_warm_pipeline_once()


class _FakeMemoryProvider:
    """Minimal stand-in for MemoryProvider that satisfies run_sync.

    Uses the MemoryStore's connection for memory operations. Config
    queries that hit missing core tables are caught and return ``{}``.
    """

    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self._conn = store._conn  # noqa: SLF001 — test helper

    async def run_sync(self, fn: Any) -> Any:
        try:
            return await asyncio.to_thread(fn, self._conn)
        except Exception:
            return {}


def _make_context(store: MemoryStore, session_id: int) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "memory_provider": _FakeMemoryProvider(store),
        "memory_writes_enabled": True,
        "owner_user_id": 1,
    }


def _seed_memory(store: MemoryStore, facts: list[dict[str, Any]]) -> None:
    for fact in facts:
        store.write_semantic_fact(
            MemoryCandidate(
                subject=fact["subject"],
                predicate=fact["predicate"],
                value=fact["value"],
                confidence=fact.get("confidence", 0.8),
                source_text=fact.get("source_text", "test seed"),
            ),
        )


def _assert_turn(script_id: str, turn_idx: int, result: Any, expect: dict[str, Any]) -> None:
    """Run all assertions for a single turn."""
    label = f"{script_id}[turn {turn_idx}]"

    if "fast_lane_matched" in expect:
        assert result.fast_lane.matched is expect["fast_lane_matched"], (
            f"{label}: fast_lane.matched={result.fast_lane.matched}"
        )

    if "capability" in expect:
        if result.fast_lane.matched:
            assert result.fast_lane.capability == expect["capability"], (
                f"{label}: fast_lane capability={result.fast_lane.capability}"
            )
        else:
            capabilities = [r.capability for r in result.routes]
            assert expect["capability"] in capabilities, (
                f"{label}: expected capability {expect['capability']} in {capabilities}"
            )

    if "chunk_count" in expect:
        assert len(result.chunks) == expect["chunk_count"], (
            f"{label}: chunk_count={len(result.chunks)}"
        )

    if "response_contains" in expect:
        needle = expect["response_contains"].lower()
        haystack = result.response.output_text.lower()
        assert needle in haystack, (
            f"{label}: expected '{needle}' in response '{haystack[:200]}'"
        )

    if "response_contains_all" in expect:
        haystack = result.response.output_text.lower()
        for needle in expect["response_contains_all"]:
            assert needle.lower() in haystack, (
                f"{label}: expected '{needle}' in response"
            )

    if "llm_used" in expect:
        assert result.request_spec.llm_used is expect["llm_used"], (
            f"{label}: llm_used={result.request_spec.llm_used}"
        )

    if "llm_reason" in expect:
        assert result.request_spec.llm_reason == expect["llm_reason"], (
            f"{label}: llm_reason={result.request_spec.llm_reason}"
        )

    if "subjects_contain" in expect:
        haystack_parts: list[str] = []
        for extraction in result.extractions:
            haystack_parts.extend(extraction.subject_candidates)
            haystack_parts.extend(extraction.references)
        for chunk in result.chunks:
            haystack_parts.append(chunk.text)
        haystack = " ".join(haystack_parts).lower()
        for needle in expect["subjects_contain"]:
            assert needle.lower() in haystack, (
                f"{label}: expected subject '{needle}' in {haystack_parts}"
            )

    if "resolved_person" in expect:
        expected = expect["resolved_person"].lower()
        resolved_names = [
            str((res.params or {}).get("person_name") or "").lower()
            for res in result.resolutions
        ]
        assert expected in resolved_names, (
            f"{label}: expected resolved person '{expected}' in {resolved_names}"
        )

    if "resolved_target_contains" in expect:
        needle = expect["resolved_target_contains"].lower()
        targets = [res.resolved_target.lower() for res in result.resolutions]
        assert any(needle in t for t in targets), (
            f"{label}: expected '{needle}' in resolved targets {targets}"
        )

    if "max_step_ms" in expect:
        timings = {step.name: step.timing_ms for step in result.trace.steps}
        for step_name, ceiling in expect["max_step_ms"].items():
            assert step_name in timings, (
                f"{label}: step '{step_name}' missing from trace"
            )
            assert timings[step_name] <= ceiling, (
                f"{label}: step '{step_name}' took {timings[step_name]}ms (limit {ceiling}ms)"
            )

    if "max_total_ms" in expect:
        actual = result.trace_summary.total_timing_ms
        assert actual <= expect["max_total_ms"], (
            f"{label}: total pipeline took {actual}ms (limit {expect['max_total_ms']}ms)"
        )

    if "tone_signal" in expect:
        assert result.signals.tone_signal == expect["tone_signal"], (
            f"{label}: tone_signal={result.signals.tone_signal}"
        )

    if "interaction_signal" in expect:
        assert result.signals.interaction_signal == expect["interaction_signal"], (
            f"{label}: interaction_signal={result.signals.interaction_signal}"
        )

    # --- new multi-turn assertions ---

    if "likely_goal" in expect:
        actual_goal = result.request_spec.context.get("likely_goal", "")
        assert actual_goal == expect["likely_goal"], (
            f"{label}: likely_goal='{actual_goal}', expected '{expect['likely_goal']}'"
        )

    if "memory_slot_contains" in expect:
        slots = result.request_spec.context.get("memory_slots", {})
        for slot_name, needle in expect["memory_slot_contains"].items():
            slot_text = slots.get(slot_name, "")
            assert needle.lower() in slot_text.lower(), (
                f"{label}: expected '{needle}' in memory slot '{slot_name}', "
                f"got '{slot_text[:200]}'"
            )


@pytest.mark.parametrize(
    "script", _SCRIPTS, ids=[s["id"] for s in _SCRIPTS],
)
@pytest.mark.anyio
async def test_conversation_script(script: dict[str, Any]) -> None:
    if script.get("known_tuning_gap"):
        pytest.xfail(
            reason=script.get("tuning_gap_reason", "routing/resolution tuning gap"),
        )

    store = MemoryStore(":memory:")
    session_id = store.create_session(owner_user_id=1)
    ctx = _make_context(store, session_id)

    if script.get("seed_memory"):
        _seed_memory(store, script["seed_memory"])

    for turn_idx, turn in enumerate(script["turns"]):
        result = await run_pipeline_async(
            turn["utterance"], context=dict(ctx),
        )
        if "expect" in turn:
            _assert_turn(script["id"], turn_idx, result, turn["expect"])
