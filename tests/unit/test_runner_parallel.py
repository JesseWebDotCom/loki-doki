"""Unit tests for ``run_sources_parallel_scored`` and the knowledge
adapter's subject-coverage scoring helper.

These live in their own file (separate from ``test_v2_skill_adapters``)
because they exercise the runner helper and the scorer in isolation —
no adapter, no v1 skill, no monkeypatching of module-level singletons.
"""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.orchestrator.skills._runner import AdapterResult, run_sources_parallel_scored, score_subject_coverage as _score_subject_coverage


def _ok(text: str, *, mechanism: str = "stub") -> AdapterResult:
    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used=mechanism,
        source_url=f"https://example.test/{mechanism}",
        source_title=f"Stub {mechanism}",
        data={"stub": True},
    )


def _fail(error: str, *, mechanism: str = "stub") -> AdapterResult:
    return AdapterResult(
        output_text="",
        success=False,
        mechanism_used=mechanism,
        error=error,
    )


async def _wrap(value: AdapterResult) -> AdapterResult:
    """Wrap a plain result in an awaitable so it can be gathered."""
    return value


async def _raise(exc: BaseException) -> AdapterResult:
    raise exc


# ---- run_sources_parallel_scored -------------------------------------------


@pytest.mark.anyio
async def test_parallel_runner_picks_highest_score():
    """When multiple sources succeed, the highest-scoring one wins even
    if it is not first in the source list."""
    scores = {"a": 0.4, "b": 0.95}

    result = await run_sources_parallel_scored(
        [
            ("a", _wrap(_ok("A body"))),
            ("b", _wrap(_ok("B body"))),
        ],
        score=lambda r: scores[r.output_text[0].lower()],
        threshold=0.3,
        fallback_text="fallback",
    )
    assert result.success is True
    assert result.output_text == "B body"
    assert result.data["winner"] == "b"
    assert result.data["winner_score"] == 0.95


@pytest.mark.anyio
async def test_parallel_runner_ties_break_by_source_list_order():
    """Two sources with identical scores → the one that appears first
    in the ``sources`` list wins. That's the caller's preference order,
    used by knowledge_query to prefer authoritative Wikipedia over web."""
    result = await run_sources_parallel_scored(
        [
            ("preferred", _wrap(_ok("preferred body"))),
            ("also_good", _wrap(_ok("other body"))),
        ],
        score=lambda r: 1.0,
        threshold=0.5,
        fallback_text="fallback",
    )
    assert result.success is True
    assert result.data["winner"] == "preferred"
    assert result.output_text == "preferred body"


@pytest.mark.anyio
async def test_parallel_runner_drops_candidates_below_threshold():
    """A candidate that succeeded but scored below the threshold must
    be filtered out even if no other candidate qualifies."""
    result = await run_sources_parallel_scored(
        [
            ("only", _wrap(_ok("something"))),
        ],
        score=lambda r: 0.2,
        threshold=0.5,
        fallback_text="couldn't find anything",
    )
    assert result.success is False
    assert result.output_text == "couldn't find anything"
    assert result.data["winner"] is None
    assert result.data["candidates"][0]["score"] == 0.2
    assert result.data["candidates"][0]["success"] is True


@pytest.mark.anyio
async def test_parallel_runner_falls_back_when_all_sources_fail():
    """Every source fails → fallback_text is returned as a failed
    AdapterResult, with per-candidate errors preserved in the trace."""
    result = await run_sources_parallel_scored(
        [
            ("a", _wrap(_fail("a boom"))),
            ("b", _wrap(_fail("b boom"))),
        ],
        score=lambda r: 1.0,
        threshold=0.5,
        fallback_text="dead on arrival",
    )
    assert result.success is False
    assert result.output_text == "dead on arrival"
    assert result.mechanism_used == "parallel"
    assert {c["error"] for c in result.data["candidates"]} == {"a boom", "b boom"}


@pytest.mark.anyio
async def test_parallel_runner_handles_source_exceptions():
    """A raised exception from one coroutine must not kill the runner —
    the other source should still be scored and can still win."""
    result = await run_sources_parallel_scored(
        [
            ("crashy", _raise(RuntimeError("boom"))),
            ("stable", _wrap(_ok("stable body"))),
        ],
        score=lambda r: 0.9,
        threshold=0.5,
        fallback_text="nope",
    )
    assert result.success is True
    assert result.data["winner"] == "stable"
    crashy = next(c for c in result.data["candidates"] if c["source"] == "crashy")
    assert crashy["success"] is False
    assert "boom" in crashy["error"]


@pytest.mark.anyio
async def test_parallel_runner_scorer_exception_treated_as_zero():
    """A bug in the scoring function must not crash the skill — the
    offending candidate just gets a score of 0.0."""

    def boom(_result: AdapterResult) -> float:
        raise ValueError("bad scorer")

    result = await run_sources_parallel_scored(
        [
            ("a", _wrap(_ok("A"))),
        ],
        score=boom,
        threshold=0.5,
        fallback_text="nope",
    )
    assert result.success is False
    assert result.data["candidates"][0]["score"] == 0.0


@pytest.mark.anyio
async def test_parallel_runner_runs_sources_concurrently():
    """Wall-clock cost should be ~max(sources), not the sum. This
    protects the fan-out invariant against accidental sequentialization
    (e.g. someone awaiting inside the list comprehension)."""

    async def slow(value: AdapterResult, delay: float) -> AdapterResult:
        await asyncio.sleep(delay)
        return value

    delay = 0.1
    loop = asyncio.get_running_loop()
    start = loop.time()
    result = await run_sources_parallel_scored(
        [
            ("a", slow(_ok("A body"), delay)),
            ("b", slow(_ok("B body"), delay)),
            ("c", slow(_ok("C body"), delay)),
        ],
        score=lambda r: 1.0,
        threshold=0.5,
        fallback_text="nope",
    )
    elapsed = loop.time() - start
    assert result.success is True
    # Three sequential sleeps would be ~0.3s; concurrent is ~0.1s.
    # Use 0.25s as the sequential-vs-concurrent cutoff — generous
    # enough to tolerate test-runner jitter without letting a
    # fully-sequential regression slip through.
    assert elapsed < 0.25, f"sources appear to have run sequentially (elapsed={elapsed:.3f}s)"


# ---- _score_subject_coverage -----------------------------------------------


def test_score_subject_coverage_all_tokens_present():
    score = _score_subject_coverage(
        "who is arthur miller",
        "Arthur Asher Miller was an American playwright.",
    )
    assert score == 1.0


def test_score_subject_coverage_partial_coverage():
    """The "claude mythos" case: body mentions claude but not mythos."""
    score = _score_subject_coverage(
        "what is claude mythos",
        "Claude is a series of large language models developed by Anthropic.",
    )
    assert score == 0.5


def test_score_subject_coverage_empty_significant_tokens_trusts_source():
    """Queries with no 4+ char content tokens (e.g. 'hi there') return
    1.0 so the caller falls back to source preference instead of
    rejecting perfectly valid small-talk responses."""
    score = _score_subject_coverage("hi", "Anything at all.")
    assert score == 1.0


def test_score_subject_coverage_empty_body_returns_zero():
    score = _score_subject_coverage("what is langchain", "")
    assert score == 0.0


def test_score_subject_coverage_folds_diacritics():
    """Query 'beyonce songs' must match a body that spells 'Beyoncé'."""
    score = _score_subject_coverage(
        "beyonce songs",
        "Beyoncé Giselle Knowles-Carter is known for her songs and performances.",
    )
    assert score == 1.0


def test_score_subject_coverage_descriptor_token_covered_by_body():
    """'queensryche band' → wiki lead literally says 'American heavy
    metal band' → both tokens present → score 1.0. This is the case
    that a title-only gate can't distinguish from 'claude mythos'."""
    score = _score_subject_coverage(
        "queensryche band",
        "Queensrÿche is an American heavy metal band from Bellevue, Washington.",
    )
    assert score == 1.0
