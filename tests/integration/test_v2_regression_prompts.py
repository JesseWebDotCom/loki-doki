"""Phase 6 regression suite — runs every prompt in the fixture through
the full v2 orchestrator pipeline and asserts on the outcome shape.

A new edge case = one new entry in
``tests/fixtures/v2_regression_prompts.json``. No code change needed.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from v2.orchestrator.core.pipeline import run_pipeline_async


_FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "v2_regression_prompts.json"


def _load_cases() -> list[dict[str, Any]]:
    payload = json.loads(_FIXTURE_PATH.read_text())
    return list(payload.get("cases") or [])


_CASES = _load_cases()


@pytest.mark.parametrize("case", _CASES, ids=[case["id"] for case in _CASES])
@pytest.mark.anyio
async def test_v2_regression_prompt(case):
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

    if "gemma_used" in expect:
        assert result.request_spec.gemma_used is expect["gemma_used"], (
            f"{case['id']}: gemma_used={result.request_spec.gemma_used}"
        )

    if "gemma_reason" in expect:
        assert result.request_spec.gemma_reason == expect["gemma_reason"], (
            f"{case['id']}: gemma_reason={result.request_spec.gemma_reason}"
        )
