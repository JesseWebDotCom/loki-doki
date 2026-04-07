"""End-to-end pipeline tests with real skills wired through the orchestrator.

These tests deliberately do NOT mock at the skill API boundary the way
``tests/unit/test_skill_*.py`` do. Instead, they mock only at the
network layer (``httpx.AsyncClient.get``), so the full orchestrator →
SkillExecutor → real ``WikipediaSkill`` path is exercised. This is the
layer where the 2026-04-06 ``"Query parameter required"`` regression
lived: every individual unit was green, but the contract between them
was broken.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from lokidoki.core import skill_factory
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor
from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill


WIKI_API_OK = {
    "query": {
        "pages": {
            "12345": {
                "pageid": 12345,
                "title": "Danny McBride",
                "extract": "Daniel Richard McBride is an American actor and comedian.",
            }
        }
    }
}


def _build_orchestrator(
    decomp: DecompositionResult, registry: SkillRegistry, memory: MemoryProvider
) -> Orchestrator:
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)

    mock_inference = AsyncMock()

    async def _stream(*_a, **_kw):
        yield "ok"

    mock_inference.generate_stream = lambda *a, **kw: _stream()

    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
        registry=registry,
        skill_executor=SkillExecutor(),
    )


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "pipeline.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture(autouse=True)
def _reset_skill_singletons():
    """WikipediaSkill is cached as a singleton across tests; reset so each
    test gets a fresh instance with a clean cache."""
    skill_factory.reset_instances()
    yield
    skill_factory.reset_instances()


@pytest.mark.anyio
async def test_pipeline_routes_wiki_skill_with_empty_decomposer_params(memory):
    """Regression: when the decomposer emits ``parameters: {}`` (as the
    real LLM frequently does), the orchestrator must still successfully
    execute ``knowledge_wiki`` by falling back to ``distilled_query``.

    Pre-fix behavior: every mechanism failed with ``"Query parameter
    required"`` and ``routing_log[0].status == "failed"``.
    """
    registry = SkillRegistry()
    registry.scan()
    assert "knowledge_wiki" in registry.skills

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="knowledge_wiki.search_knowledge",
            distilled_query="Danny McBride",
            parameters={},  # the bug condition
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(decomp, registry, memory)
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = WIKI_API_OK

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
        events = []
        async for event in orch.process(
            "Is Danny McBride still acting?", user_id=uid, session_id=sid
        ):
            events.append(event)

    routing_done = [e for e in events if e.phase == "routing" and e.status == "done"]
    assert len(routing_done) == 1, "routing phase did not complete"
    log = routing_done[0].data["routing_log"]
    assert len(log) == 1
    assert log[0]["status"] == "success", (
        f"knowledge_wiki failed end-to-end with empty decomposer params: {log[0]}"
    )
    assert log[0]["mechanism"] == "mediawiki_api"
    assert routing_done[0].data["skills_resolved"] == 1
    assert routing_done[0].data["skills_failed"] == 0


@pytest.mark.anyio
async def test_pipeline_wiki_failure_surfaces_in_routing_log(memory):
    """Negative case: when the API genuinely returns no article, the
    failure path should still produce a clean routing_log entry that
    the UI can display (with mechanism_log so the tooltip works)."""
    registry = SkillRegistry()
    registry.scan()

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="knowledge_wiki.search_knowledge",
            distilled_query="zzznonexistententity",
            parameters={},
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )
    orch = _build_orchestrator(decomp, registry, memory)
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    miss_response = MagicMock()
    miss_response.status_code = 200
    miss_response.json.return_value = {"query": {"pages": {"-1": {"missing": ""}}, "search": []}}

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=miss_response):
        events = []
        async for event in orch.process(
            "zzznonexistententity", user_id=uid, session_id=sid
        ):
            events.append(event)

    routing_done = [e for e in events if e.phase == "routing" and e.status == "done"]
    log = routing_done[0].data["routing_log"]
    assert log[0]["status"] == "failed"
    # mechanism_log must be populated for the UI tooltip / copy output.
    assert log[0]["mechanism_log"], "failed routing entry has empty mechanism_log"
    methods_tried = {m["method"] for m in log[0]["mechanism_log"]}
    assert "mediawiki_api" in methods_tried
    # Latency should be reported even on failure (UI shows it instead of "—").
    assert "latency_ms" in log[0]
