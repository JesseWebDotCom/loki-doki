from __future__ import annotations

import pytest

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.adapters.calculator import CalculatorAdapter
from lokidoki.orchestrator.adapters.registry import adapt, resolve_adapter
from lokidoki.orchestrator.core.pipeline_phases import run_execute_phase
from lokidoki.orchestrator.core.types import (
    RequestChunk,
    ResolutionResult,
    RouteMatch,
    TraceData,
)
from lokidoki.orchestrator.registry.runtime import get_runtime


def test_source_requires_title():
    with pytest.raises(TypeError):
        Source()  # type: ignore[call-arg]


def test_adapter_output_defaults_are_empty():
    output = AdapterOutput()
    assert output.summary_candidates == ()
    assert output.facts == ()
    assert output.sources == ()
    assert output.media == ()
    assert output.actions == ()
    assert output.artifact_candidates == ()
    assert output.follow_up_candidates == ()
    assert output.raw is None


def test_registry_returns_none_for_unknown_adapter():
    assert resolve_adapter("unknown") is None


def test_adapt_falls_back_to_raw_for_unknown_adapter():
    result = MechanismResult(success=True, data={"hello": "there"})
    output = adapt("unknown", result)
    assert output.summary_candidates == ()
    assert output.raw == {"hello": "there"}


def test_calculator_adapter_emits_summary_candidate():
    adapter = CalculatorAdapter()
    output = adapter.adapt(
        MechanismResult(
            success=True,
            data={"result": 3, "expression": "1+2"},
        )
    )
    assert output.summary_candidates == ("1+2 = 3",)


@pytest.mark.anyio
async def test_execute_phase_attaches_calculator_adapter_output():
    runtime = get_runtime()
    chunk = RequestChunk(text="1+2", index=0)
    route = RouteMatch(chunk_index=0, capability="calculate", confidence=0.9)
    implementation = runtime.select_handler(0, "calculate")
    resolution = ResolutionResult(
        chunk_index=0,
        resolved_target="1+2",
        source="direct",
        confidence=1.0,
        params={"expression": "1+2"},
    )

    executions = await run_execute_phase(
        TraceData(),
        {},
        runtime,
        [chunk],
        [route],
        [implementation],
        [resolution],
    )

    assert executions[0].success is True
    assert executions[0].adapter_output is not None
    assert executions[0].adapter_output.summary_candidates
