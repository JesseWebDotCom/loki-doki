"""Phase 6 retry / timeout coverage for the executor."""
from __future__ import annotations

import asyncio

import pytest

from lokidoki.orchestrator.core.types import (
    ImplementationSelection,
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)
from lokidoki.orchestrator.execution.errors import HandlerError, TransientHandlerError
from lokidoki.orchestrator.execution.executor import execute_chunk_async, register_handler


def _selection(handler_name: str) -> ImplementationSelection:
    return ImplementationSelection(
        chunk_index=0,
        capability="test_capability",
        handler_name=handler_name,
        implementation_id="test.impl",
        priority=10,
        candidate_count=1,
    )


@pytest.mark.anyio
async def test_executor_retries_transient_failures_then_succeeds():
    attempts: list[int] = []

    def flaky(payload):
        attempts.append(1)
        if len(attempts) < 2:
            raise TransientHandlerError("transient")
        return {"output_text": "ok"}

    register_handler("test.flaky", flaky)
    chunk = RequestChunk(text="hi", index=0)
    route = RouteMatch(chunk_index=0, capability="test_capability", confidence=0.9)
    resolution = ResolutionResult(chunk_index=0, resolved_target="", source="route", confidence=0.9)

    result = await execute_chunk_async(chunk, route, _selection("test.flaky"), resolution)

    assert result.success is True
    assert result.output_text == "ok"
    assert result.attempts >= 2


@pytest.mark.anyio
async def test_executor_records_timeout_failure_without_raising():
    def slow(payload):
        import time
        time.sleep(0.5)
        return {"output_text": "late"}

    register_handler("test.slow", slow)
    chunk = RequestChunk(text="hi", index=0)
    route = RouteMatch(chunk_index=0, capability="test_capability", confidence=0.9)
    resolution = ResolutionResult(chunk_index=0, resolved_target="", source="route", confidence=0.9)

    # Override the configured timeout to a very small value for this test.
    from lokidoki.orchestrator.core import config as pipeline_config

    original = pipeline_config.CONFIG.handler_timeout_s
    object.__setattr__(pipeline_config.CONFIG, "handler_timeout_s", 0.05)
    try:
        result = await execute_chunk_async(chunk, route, _selection("test.slow"), resolution)
    finally:
        object.__setattr__(pipeline_config.CONFIG, "handler_timeout_s", original)

    assert result.success is False
    assert "timed out" in (result.error or "")


@pytest.mark.anyio
async def test_executor_records_handler_error_without_retry():
    calls: list[int] = []

    def boom(payload):
        calls.append(1)
        raise HandlerError("nope")

    register_handler("test.boom", boom)
    chunk = RequestChunk(text="hi", index=0)
    route = RouteMatch(chunk_index=0, capability="test_capability", confidence=0.9)
    resolution = ResolutionResult(chunk_index=0, resolved_target="", source="route", confidence=0.9)

    result = await execute_chunk_async(chunk, route, _selection("test.boom"), resolution)

    assert result.success is False
    assert result.error == "nope"
    assert len(calls) == 1
