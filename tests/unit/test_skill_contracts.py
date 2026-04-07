"""Cross-skill contract tests.

Catches the class of bug where a skill's manifest declares a required
parameter (e.g. ``query``) but the orchestrator hands the skill a dict
that doesn't contain it. The unit tests for individual skills mock
across this seam by hand-building the parameters dict, so they cannot
detect a regression in the orchestrator's parameter-merging logic.

Triggered by the 2026-04-06 ``knowledge_wiki`` failure where the
decomposer emitted ``parameters: {}`` and every mechanism short-circuited
on ``"Query parameter required"``.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from lokidoki.core import orchestrator_skills as orchestrator_module
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import BaseSkill, MechanismResult


class _CapturingSkill(BaseSkill):
    """Records parameters passed by the executor; always returns success."""

    def __init__(self) -> None:
        self.last_params: dict | None = None

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        self.last_params = parameters
        return MechanismResult(success=True, data={"ok": True})


@pytest.fixture
def registry() -> SkillRegistry:
    r = SkillRegistry()
    r.scan()
    assert r.skills, "registry scan returned no skills — check skills_dir"
    return r


def _intents_with_required_params(registry: SkillRegistry) -> list[tuple[str, str, list[str]]]:
    """Yield (skill_id, qualified_intent, required_param_keys) for every
    intent whose manifest declares any required parameter."""
    out: list[tuple[str, str, list[str]]] = []
    for skill_id, manifest in registry.skills.items():
        params = manifest.get("parameters", {})
        required = [k for k, spec in params.items() if isinstance(spec, dict) and spec.get("required")]
        if not required:
            continue
        for intent in manifest.get("intents", []):
            out.append((skill_id, f"{skill_id}.{intent}", required))
    return out


async def _build_orchestrator(
    registry: SkillRegistry, decomp: DecompositionResult, memory: MemoryProvider
) -> tuple[Orchestrator, int, int]:
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)

    mock_inference = AsyncMock()

    async def _stream(*_a, **_kw):
        yield "ok"

    mock_inference.generate_stream = lambda *a, **kw: _stream()

    policy = ModelPolicy(platform="mac")
    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(inference_client=mock_inference, policy=policy),
        registry=registry,
    )
    uid = await memory.default_user_id()
    sid = await memory.create_session(uid)
    return orch, uid, sid


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "skill_contracts.db"))
    await mp.initialize()
    yield mp
    await mp.close()


def _discover_intents_with_required_params() -> list[tuple[str, str, list[str]]]:
    r = SkillRegistry()
    r.scan()
    return _intents_with_required_params(r)


_DISCOVERED_CONTRACTS = _discover_intents_with_required_params()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "skill_id,qualified_intent,required",
    _DISCOVERED_CONTRACTS or [pytest.param("_none_", "_.x", [], marks=pytest.mark.skip(reason="no skills declare required params"))],
    ids=[f"{s}|{i}" for s, i, _ in _DISCOVERED_CONTRACTS] or ["none"],
)
async def test_orchestrator_populates_required_skill_params(
    skill_id, qualified_intent, required, monkeypatch, memory
):
    """For every (skill, intent) with required params, the orchestrator
    must hand the skill a parameters dict containing each required key,
    even when the decomposer emits ``parameters={}``.

    This is the contract that broke with knowledge_wiki: the decomposer
    omitted ``query``, the orchestrator passed the empty dict through,
    and the skill failed on every mechanism. The fix is the
    ``setdefault("query", ask.distilled_query)`` in
    ``Orchestrator.process``; this test pins it.
    """
    registry = SkillRegistry()
    registry.scan()

    capture = _CapturingSkill()
    monkeypatch.setattr(orchestrator_module, "get_skill_instance", lambda sid, config=None: capture)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent=qualified_intent,
            distilled_query="raspberry pi",
            parameters={},  # decomposer emitted nothing — the bug condition
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, uid, sid = await _build_orchestrator(registry, decomp, memory)
    async for _ in orch.process("raspberry pi", user_id=uid, session_id=sid):
        pass

    assert capture.last_params is not None, (
        f"{skill_id}: skill was never invoked — orchestrator dropped the ask"
    )
    for key in required:
        assert key in capture.last_params, (
            f"{skill_id}.{qualified_intent}: orchestrator did not populate "
            f"required parameter '{key}'. Got: {capture.last_params!r}"
        )
        assert capture.last_params[key], (
            f"{skill_id}.{qualified_intent}: required parameter '{key}' "
            f"was present but empty. Got: {capture.last_params[key]!r}"
        )


@pytest.mark.anyio
async def test_distilled_query_is_default_for_query_param(monkeypatch, memory):
    """Specific guarantee: when a skill needs ``query`` and the decomposer
    omits it, the orchestrator falls back to ``ask.distilled_query``."""
    registry = SkillRegistry()
    registry.scan()
    wiki_intent = next(
        (f"knowledge_wiki.{i}" for i in registry.skills["knowledge_wiki"]["intents"]),
        None,
    )
    assert wiki_intent, "knowledge_wiki must expose at least one intent"

    capture = _CapturingSkill()
    monkeypatch.setattr(orchestrator_module, "get_skill_instance", lambda sid, config=None: capture)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent=wiki_intent,
            distilled_query="is danny mcbride still acting",
            parameters={},
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, uid, sid = await _build_orchestrator(registry, decomp, memory)
    async for _ in orch.process("is danny mcbride still acting", user_id=uid, session_id=sid):
        pass

    assert capture.last_params == {"query": "is danny mcbride still acting"}


@pytest.mark.anyio
async def test_decomposer_supplied_params_are_not_clobbered(monkeypatch, memory):
    """If the decomposer DOES supply a param, the orchestrator must not
    overwrite it with distilled_query."""
    registry = SkillRegistry()
    registry.scan()
    wiki_intent = next(
        (f"knowledge_wiki.{i}" for i in registry.skills["knowledge_wiki"]["intents"]),
        None,
    )

    capture = _CapturingSkill()
    monkeypatch.setattr(orchestrator_module, "get_skill_instance", lambda sid, config=None: capture)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent=wiki_intent,
            distilled_query="raw user text",
            parameters={"query": "Danny McBride"},  # LLM extracted a clean entity
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, uid, sid = await _build_orchestrator(registry, decomp, memory)
    async for _ in orch.process("raw user text", user_id=uid, session_id=sid):
        pass

    assert capture.last_params["query"] == "Danny McBride", (
        "orchestrator overwrote a decomposer-supplied param with distilled_query"
    )
