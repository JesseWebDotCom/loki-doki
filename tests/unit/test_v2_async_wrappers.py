from __future__ import annotations

import pytest

from v2.orchestrator.core.types import ChunkExtraction, ImplementationSelection, RequestChunk, ResolutionResult, RouteMatch
from v2.orchestrator.execution import executor
from v2.orchestrator.resolution import resolver
from v2.orchestrator.routing import router


@pytest.mark.anyio
async def test_v2_route_chunk_async_uses_to_thread(monkeypatch):
    calls: list[tuple] = []

    async def fake_to_thread(func, *args, **kwargs):
        calls.append((func.__name__, args, kwargs))
        return func(*args, **kwargs)

    monkeypatch.setattr(router.asyncio, "to_thread", fake_to_thread)
    chunk = RequestChunk(text="what time is it", index=0)

    result = await router.route_chunk_async(chunk)

    assert result.capability == "get_current_time"
    assert calls
    assert calls[0][0] == "route_chunk"
    assert calls[0][1][0] == chunk


@pytest.mark.anyio
async def test_v2_resolve_chunk_async_uses_to_thread(monkeypatch):
    calls: list[tuple] = []

    async def fake_to_thread(func, *args, **kwargs):
        calls.append((func.__name__, args, kwargs))
        return func(*args, **kwargs)

    monkeypatch.setattr(resolver.asyncio, "to_thread", fake_to_thread)
    chunk = RequestChunk(text="what time is it", index=0)
    extraction = ChunkExtraction(chunk_index=0, references=["time"])
    route = RouteMatch(chunk_index=0, capability="get_current_time", confidence=0.9)

    result = await resolver.resolve_chunk_async(chunk, extraction, route, {"recent_entities": []})

    assert result.resolved_target == "current_time"
    assert calls
    assert calls[0][0] == "resolve_chunks"
    assert calls[0][1][:3] == ([chunk], [extraction], [route])


@pytest.mark.anyio
async def test_v2_execute_chunk_async_offloads_handler_via_to_thread(monkeypatch):
    """The executor must offload sync handler calls so the event loop stays free."""
    calls: list[tuple] = []

    async def fake_to_thread(func, *args, **kwargs):
        calls.append((func.__name__, args, kwargs))
        return func(*args, **kwargs)

    monkeypatch.setattr(executor.asyncio, "to_thread", fake_to_thread)
    chunk = RequestChunk(text="hello", index=0)
    route = RouteMatch(chunk_index=0, capability="greeting_response", confidence=0.95)
    implementation = ImplementationSelection(
        chunk_index=0,
        capability="greeting_response",
        handler_name="core.greetings.reply",
        implementation_id="core.greeting.default",
        priority=10,
        candidate_count=1,
    )
    resolution = ResolutionResult(
        chunk_index=0,
        resolved_target="greeting",
        source="direct_utility",
        confidence=0.95,
    )

    result = await executor.execute_chunk_async(chunk, route, implementation, resolution)

    assert result.output_text == "Hello."
    assert result.success is True
    assert result.handler_name == "core.greetings.reply"
    assert calls, "executor must offload synchronous handlers via asyncio.to_thread"
    assert calls[0][0] == "_greeting_handler"
