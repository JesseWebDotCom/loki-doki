"""Pipeline history replay + failure halting."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import (
    PipelineComplete,
    PipelineHalted,
    StepDone,
    StepFailed,
    StepStart,
)
from lokidoki.bootstrap.pipeline import Pipeline
from lokidoki.bootstrap.steps import Step


def _ctx(tmp_path: Path, pipeline: Pipeline) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=pipeline.emit,
    )


def _ok_step(step_id: str) -> Step:
    async def _run(ctx: StepContext) -> None:
        return None

    return Step(id=step_id, label=step_id, run=_run)


def _failing_step(step_id: str, msg: str) -> Step:
    async def _run(ctx: StepContext) -> None:
        raise RuntimeError(msg)

    return Step(id=step_id, label=step_id, run=_run)


async def _run_and_collect(pipeline: Pipeline, steps: list[Step], ctx: StepContext) -> list:
    events: list = []

    async def _collect() -> None:
        async for evt in pipeline.subscribe():
            events.append(evt)

    collector = asyncio.create_task(_collect())
    await asyncio.sleep(0)  # let the collector register
    await pipeline.run(steps, ctx)
    await collector
    return events


def test_subscribe_replays_history(tmp_path: Path) -> None:
    pipeline = Pipeline()
    ctx = _ctx(tmp_path, pipeline)
    steps = [_ok_step("a"), _ok_step("b")]

    events = asyncio.run(_run_and_collect(pipeline, steps, ctx))
    assert isinstance(events[0], StepStart) and events[0].step_id == "a"
    done = [e for e in events if isinstance(e, StepDone)]
    assert [e.step_id for e in done] == ["a", "b"]
    assert isinstance(events[-1], PipelineComplete)


def test_late_subscriber_still_receives_all_history(tmp_path: Path) -> None:
    pipeline = Pipeline()
    ctx = _ctx(tmp_path, pipeline)
    steps = [_ok_step("a"), _ok_step("b"), _ok_step("c")]

    async def _driver() -> list:
        await pipeline.run(steps, ctx)  # fully complete before subscribing
        collected = [evt async for evt in pipeline.subscribe()]
        return collected

    events = asyncio.run(_driver())
    starts = [e for e in events if isinstance(e, StepStart)]
    assert [e.step_id for e in starts] == ["a", "b", "c"]
    assert isinstance(events[-1], PipelineComplete)


def test_failure_halts_pipeline(tmp_path: Path) -> None:
    pipeline = Pipeline()
    ctx = _ctx(tmp_path, pipeline)
    steps = [_ok_step("a"), _failing_step("b", "boom"), _ok_step("c")]

    asyncio.run(pipeline.run(steps, ctx))

    started = [e.step_id for e in pipeline.history if isinstance(e, StepStart)]
    assert started == ["a", "b"]  # c never started
    failures = [e for e in pipeline.history if isinstance(e, StepFailed)]
    assert failures and failures[0].step_id == "b"
    halted = [e for e in pipeline.history if isinstance(e, PipelineHalted)]
    assert halted and "b" in halted[0].reason
    assert pipeline.failed_step_id == "b"


def test_retry_reruns_failed_step(tmp_path: Path) -> None:
    pipeline = Pipeline()
    ctx = _ctx(tmp_path, pipeline)
    attempts = {"count": 0}

    async def _flaky(ctx: StepContext) -> None:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("first attempt")

    step_b = Step(id="b", label="b", run=_flaky)
    steps = [_ok_step("a"), step_b]

    async def _driver() -> None:
        await pipeline.run(steps, ctx)
        ok = await pipeline.retry("b", ctx)
        assert ok

    asyncio.run(_driver())
    assert attempts["count"] == 2
    done_b = [e for e in pipeline.history if isinstance(e, StepDone) and e.step_id == "b"]
    assert len(done_b) == 1
