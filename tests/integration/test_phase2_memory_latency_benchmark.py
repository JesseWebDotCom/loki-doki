from __future__ import annotations

import time
from statistics import median
from unittest.mock import AsyncMock

import pytest

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return ordered[0]
    idx = (len(ordered) - 1) * percentile
    low = int(idx)
    high = min(low + 1, len(ordered) - 1)
    frac = idx - low
    return ordered[low] + (ordered[high] - ordered[low]) * frac


def _stream(text: str):
    async def _gen(*_a, **_kw):
        yield text

    return _gen


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase2_memory_latency.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_phase2_memory_selection_stays_within_soft_chat_path_budget(memory):
    uid = await memory.get_or_create_user("default")
    prior_sid = await memory.create_session(uid)
    for i in range(12):
        await memory.upsert_fact(
            user_id=uid,
            subject="self" if i % 3 else f"luke-{i}",
            subject_type="self" if i % 3 else "person",
            predicate="likes" if i % 2 else "status",
            value=f"value-{i}",
            category="preference" if i % 2 else "event",
        )
        await memory.add_message(
            user_id=uid,
            session_id=prior_sid,
            role="user",
            content=f"Earlier thread number {i} about the cabin trip and movie night.",
        )
    sid = await memory.create_session(uid)

    decomp = DecompositionResult(
        overall_reasoning_complexity="fast",
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="pick back up on the cabin trip and my brother")],
        model="gemma4:e2b",
    )
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = _stream("Here is the summary.")

    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
    )

    latencies_ms: list[float] = []
    for i in range(5):
        start = time.perf_counter()
        async for _ in orch.process(
            f"pick back up on the cabin trip and my brother #{i}",
            user_id=uid,
            session_id=sid,
        ):
            pass
        latencies_ms.append((time.perf_counter() - start) * 1000)

    p50_ms = median(latencies_ms)
    p95_ms = _percentile(latencies_ms, 0.95)

    assert p50_ms > 0
    assert p95_ms > 0
    assert p95_ms < 500
