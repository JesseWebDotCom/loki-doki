"""Phase 6 regression suite — runs every prompt in the fixture through
the full v2 orchestrator pipeline and asserts on the outcome shape.

A new edge case = one new entry in
``tests/fixtures/regression_prompts.json``. No code change needed.

Supported per-case ``expect`` keys:

- ``fast_lane_matched`` (bool)
- ``capability`` (str — appears either as the fast-lane capability or
  in any route)
- ``chunk_count`` / ``primary_chunk_count`` / ``supporting_context_chunk_count``
- ``response_contains`` / ``response_contains_all``
- ``llm_used`` / ``llm_reason``
- ``subjects_contain`` (list[str] — every needle must appear, lowercased,
  inside at least one chunk's subject_candidates / references / chunk text)
- ``resolved_person`` (str — the chunk-level resolution must surface this
  person_name in its params; the people DB alias resolver did its job)
- ``max_step_ms`` (dict[str, float] — per-step timing ceiling; only the
  steps named are checked)
- ``max_total_ms`` (float — total pipeline timing ceiling)
- ``tone_signal`` / ``interaction_signal`` (str — equality check on the
  detected tone / interaction signal)

Per-step / total timings are validated against a *warmed* pipeline. The
fixture is run twice and only the second run is timed, so spaCy /
fastembed cold-start cost is excluded.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from lokidoki.orchestrator.core.pipeline import run_pipeline_async


_FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "regression_prompts.json"


def _load_cases() -> list[dict[str, Any]]:
    payload = json.loads(_FIXTURE_PATH.read_text())
    return list(payload.get("cases") or [])


_CASES = _load_cases()


def _warm_pipeline_once() -> None:
    """Warm spaCy + fastembed at import time so per-step timing assertions
    measure steady-state cost, not cold-start cost."""

    async def _warm() -> None:
        await run_pipeline_async("hello")
        await run_pipeline_async("what time is the new mario movie playing")

    asyncio.run(_warm())


_warm_pipeline_once()


@pytest.mark.parametrize("case", _CASES, ids=[case["id"] for case in _CASES])
@pytest.mark.anyio
async def test_regression_prompt(case):
    if case.get("known_tuning_gap"):
        pytest.xfail(
            reason=case.get("tuning_gap_reason", "routing precision tuning gap"),
        )
    expect = case["expect"]
    result = await run_pipeline_async(case["utterance"], context=case.get("context"))

    if "fast_lane_matched" in expect:
        assert result.fast_lane.matched is expect["fast_lane_matched"], (
            f"{case['id']}: fast_lane.matched={result.fast_lane.matched}"
        )

    if "capability" in expect:
        if result.fast_lane.matched:
            assert result.fast_lane.capability == expect["capability"], (
                f"{case['id']}: fast_lane capability mismatch"
            )
        else:
            capabilities = [route.capability for route in result.routes]
            assert expect["capability"] in capabilities, (
                f"{case['id']}: expected capability {expect['capability']} in {capabilities}"
            )

    if "chunk_count" in expect:
        assert len(result.chunks) == expect["chunk_count"], (
            f"{case['id']}: chunk_count={len(result.chunks)}"
        )

    if "primary_chunk_count" in expect:
        primaries = [chunk for chunk in result.chunks if chunk.role == "primary_request"]
        assert len(primaries) == expect["primary_chunk_count"], (
            f"{case['id']}: primary_chunk_count={len(primaries)}"
        )

    if "supporting_context_chunk_count" in expect:
        supporting = [chunk for chunk in result.chunks if chunk.role == "supporting_context"]
        assert len(supporting) == expect["supporting_context_chunk_count"], (
            f"{case['id']}: supporting_context_chunk_count={len(supporting)}"
        )

    if "response_contains" in expect:
        needle = expect["response_contains"].lower()
        haystack = result.response.output_text.lower()
        assert needle in haystack, (
            f"{case['id']}: expected '{needle}' in response '{haystack}'"
        )

    if "response_contains_all" in expect:
        haystack = result.response.output_text.lower()
        for needle in expect["response_contains_all"]:
            assert needle.lower() in haystack, (
                f"{case['id']}: expected '{needle}' in response '{haystack}'"
            )

    if "llm_used" in expect:
        assert result.request_spec.llm_used is expect["llm_used"], (
            f"{case['id']}: llm_used={result.request_spec.llm_used}"
        )

    if "llm_reason" in expect:
        assert result.request_spec.llm_reason == expect["llm_reason"], (
            f"{case['id']}: llm_reason={result.request_spec.llm_reason}"
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
                f"{case['id']}: expected subject/reference '{needle}' in {haystack_parts}"
            )

    if "resolved_person" in expect:
        expected = expect["resolved_person"].lower()
        resolved_names = [
            str((res.params or {}).get("person_name") or "").lower()
            for res in result.resolutions
        ]
        assert expected in resolved_names, (
            f"{case['id']}: expected resolved person '{expected}' in {resolved_names}"
        )

    if "max_step_ms" in expect:
        timings_by_step = {step.name: step.timing_ms for step in result.trace.steps}
        for step_name, ceiling_ms in expect["max_step_ms"].items():
            assert step_name in timings_by_step, (
                f"{case['id']}: step '{step_name}' missing from trace"
            )
            actual = timings_by_step[step_name]
            assert actual <= ceiling_ms, (
                f"{case['id']}: step '{step_name}' took {actual}ms (limit {ceiling_ms}ms)"
            )

    if "max_total_ms" in expect:
        actual_total = result.trace_summary.total_timing_ms
        assert actual_total <= expect["max_total_ms"], (
            f"{case['id']}: total pipeline took {actual_total}ms "
            f"(limit {expect['max_total_ms']}ms)"
        )

    if "tone_signal" in expect:
        assert result.signals.tone_signal == expect["tone_signal"], (
            f"{case['id']}: tone_signal={result.signals.tone_signal}"
        )

    if "interaction_signal" in expect:
        assert result.signals.interaction_signal == expect["interaction_signal"], (
            f"{case['id']}: interaction_signal={result.signals.interaction_signal}"
        )
