from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.skill_executor import SkillResult
from lokidoki.evals.phase1 import Phase1BenchmarkCase, run_phase1_chat_path_benchmark
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "phase1_latency.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("tester")

    fake_user = User(
        id=uid,
        username="tester",
        role="admin",
        status="active",
        last_password_auth_at=None,
    )

    async def _override_user():
        return fake_user

    async def _override_memory():
        return mp

    app.dependency_overrides[current_user] = _override_user
    app.dependency_overrides[get_memory] = _override_memory
    yield {"memory": mp, "user_id": uid}
    app.dependency_overrides.clear()
    await mp.close()


class _FakeDecomposer:
    def __init__(self, *args, **kwargs):
        self._num_ctx = 8192

    async def decompose(self, user_input: str, **kwargs):
        mapping = {
            "I like hiking": DecompositionResult(
                overall_reasoning_complexity="fast",
                long_term_memory=[{
                    "subject_type": "self",
                    "predicate": "likes",
                    "value": "hiking",
                    "kind": "preference",
                    "category": "preference",
                }],
                asks=[Ask(ask_id="ask_ack", intent="direct_chat", distilled_query=user_input)],
                model="gemma4:e2b",
                latency_ms=1.0,
            ),
            "Who is Danny McBride?": DecompositionResult(
                overall_reasoning_complexity="fast",
                asks=[Ask(
                    ask_id="ask_ground",
                    intent="knowledge_wiki.search_knowledge",
                    distilled_query="Danny McBride",
                    response_shape="verbatim",
                    capability_need="encyclopedic",
                )],
                model="gemma4:e2b",
                latency_ms=1.0,
            ),
            "Explain quantum physics in detail": DecompositionResult(
                overall_reasoning_complexity="thinking",
                asks=[Ask(
                    ask_id="ask_full",
                    intent="direct_chat",
                    distilled_query=user_input,
                )],
                model="gemma4:e2b",
                latency_ms=1.0,
            ),
        }
        return mapping[user_input]


class _FakeInferenceClient:
    async def generate(self, *args, **kwargs):
        return "Session Title"

    def generate_stream(self, *args, **kwargs):
        prompt = kwargs.get("prompt", "")

        async def _gen():
            if "USER: I like hiking" in prompt:
                await asyncio.sleep(0.005)
                yield "Nice."
                return
            await asyncio.sleep(0.03)
            yield "Here"
            await asyncio.sleep(0.01)
            yield " is the explanation."

        return _gen()

    async def close(self):
        return None


async def _fake_run_skills(resolved_asks, registry, executor, **kwargs):
    ask = resolved_asks[0]
    if ask.ask_id != "ask_ground":
        return "", {}, [], []
    result = SkillResult(
        success=True,
        data={
            "lead": "Danny McBride is an American actor and comedian.",
            "extract": "Danny McBride is an American actor and comedian.",
        },
        source_url="https://example.com/danny-mcbride",
        source_title="Danny McBride",
        latency_ms=1.0,
        mechanism_used="stub",
    )
    return (
        '[src:1] {"lead":"Danny McBride is an American actor and comedian."}',
        {"ask_ground": result},
        [{"url": "https://example.com/danny-mcbride", "title": "Danny McBride"}],
        [{"ask_id": "ask_ground", "intent": ask.intent, "status": "success", "skill_id": "knowledge_wiki", "mechanism": "stub", "latency_ms": 1.0, "source_url": "https://example.com/danny-mcbride"}],
    )


@pytest.mark.anyio
async def test_phase1_chat_path_benchmark_shows_fast_lanes_beating_full_synthesis(_isolated_memory):
    memory = _isolated_memory["memory"]
    user_id = _isolated_memory["user_id"]

    with (
        patch("lokidoki.api.routes.chat.Decomposer", _FakeDecomposer),
        patch("lokidoki.api.routes.chat.get_inference_client", return_value=_FakeInferenceClient()),
        patch("lokidoki.core.orchestrator.run_skills", _fake_run_skills),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            runs, summary = await run_phase1_chat_path_benchmark(
                client=ac,
                memory=memory,
                user_id=user_id,
                cases=[
                    Phase1BenchmarkCase(name="ack", message="I like hiking"),
                    Phase1BenchmarkCase(name="grounded", message="Who is Danny McBride?"),
                    Phase1BenchmarkCase(name="full", message="Explain quantum physics in detail"),
                ],
                iterations=3,
            )

    assert len(runs) == 9
    assert {r["lane"] for r in runs} == {"social_ack", "grounded_direct", "full_synthesis"}
    assert summary["social_ack"]["p50_end_to_end_ms"] < summary["full_synthesis"]["p50_end_to_end_ms"]
    assert summary["grounded_direct"]["p50_end_to_end_ms"] < summary["full_synthesis"]["p50_end_to_end_ms"]
