"""End-to-end cutover checks — adapter output is the source of truth.

After chunk 5 the orchestrator no longer sniffs per-skill dict shapes to
assemble sources or media. These tests inject mock ``MechanismResult``
payloads for a representative mix of skills (calculator, Wikipedia
knowledge, web search) and confirm:

- ``request_spec.adapter_sources`` is populated from every adapter.
- ``request_spec.media`` is populated from ``execution.adapter_output.media``
  when present (adapter-first path), without calling the legacy
  ``augment_with_media`` fallback.
- ``run_execute_phase`` no longer relies on the retired
  ``_HANDLER_TO_SKILL_ID`` fallback map — the registry's
  ``ImplementationSelection.skill_id`` drives adapter dispatch.
- No decision logic in ``lokidoki/orchestrator/`` keys off
  ``mechanism_result.data[...]`` (grep invariant).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_phases import (
    _apply_adapter_outputs_to_spec,
    _media_cards_from_adapters,
    run_execute_phase,
    run_media_augmentation_phase,
)
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    RequestChunk,
    RequestSpec,
    ResolutionResult,
    RouteMatch,
    TraceData,
)
from lokidoki.orchestrator.registry.runtime import get_runtime


def _exec(idx: int, capability: str, adapter_output: AdapterOutput) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=True,
        adapter_output=adapter_output,
        raw_result={"success": True},
    )


def test_apply_adapter_outputs_flattens_sources_across_executions():
    """Sources from every successful execution land on request_spec."""
    spec = RequestSpec(trace_id="t-1", original_request="luke and leia")
    executions = [
        _exec(
            0,
            "knowledge_query",
            AdapterOutput(
                sources=(
                    Source(title="Luke", url="https://example.test/luke", kind="web"),
                ),
                facts=("Luke is a Jedi.",),
            ),
        ),
        _exec(
            1,
            "search_web",
            AdapterOutput(
                sources=(
                    Source(title="Leia", url="https://example.test/leia", kind="web"),
                ),
            ),
        ),
    ]

    _apply_adapter_outputs_to_spec(spec, executions)

    urls = [entry["url"] for entry in spec.adapter_sources]
    assert urls == ["https://example.test/luke", "https://example.test/leia"]
    titles = [entry["title"] for entry in spec.adapter_sources]
    assert titles == ["Luke", "Leia"]
    assert "Luke is a Jedi." in spec.supporting_context


def test_apply_adapter_outputs_dedupes_urls():
    """Two adapters emitting the same URL produce a single source entry."""
    spec = RequestSpec(trace_id="t-2", original_request="anakin")
    shared = Source(title="Anakin", url="https://example.test/anakin", kind="web")
    executions = [
        _exec(0, "knowledge_query", AdapterOutput(sources=(shared,))),
        _exec(1, "search_web", AdapterOutput(sources=(shared,))),
    ]

    _apply_adapter_outputs_to_spec(spec, executions)

    assert len(spec.adapter_sources) == 1
    assert spec.adapter_sources[0]["url"] == "https://example.test/anakin"


def test_apply_adapter_outputs_ignores_executions_without_adapter_output():
    """Executions whose adapter never ran (no skill_id) contribute nothing."""
    spec = RequestSpec(trace_id="t-3", original_request="noop")
    executions = [
        ExecutionResult(
            chunk_index=0, capability="unknown_capability", output_text="", success=True,
        ),
    ]

    _apply_adapter_outputs_to_spec(spec, executions)

    assert spec.adapter_sources == []


def test_media_cards_from_adapters_flattens_and_dedupes():
    """Adapter-provided media cards flow through without the legacy augmentor."""
    video_card = {
        "kind": "youtube_video",
        "url": "https://example.test/watch?v=abc",
        "video_id": "abc",
        "title": "Sample",
    }
    duplicate = {
        "kind": "youtube_video",
        "url": "https://example.test/watch?v=abc",
        "video_id": "abc",
    }
    other = {
        "kind": "youtube_channel",
        "url": "https://example.test/@leia",
        "channel_name": "Leia Organa",
    }
    executions = [
        _exec(0, "get_video", AdapterOutput(media=(video_card,))),
        _exec(1, "get_youtube_channel", AdapterOutput(media=(duplicate, other))),
    ]

    cards = _media_cards_from_adapters(executions)

    assert [c["url"] for c in cards] == [
        "https://example.test/watch?v=abc",
        "https://example.test/@leia",
    ]


@pytest.mark.anyio
async def test_media_augmentation_prefers_adapter_output(monkeypatch):
    """When an adapter already emitted media, the legacy fallback never runs."""
    sentinel = {"kind": "youtube_video", "url": "https://example.test/v=adapt"}
    executions = [_exec(0, "get_video", AdapterOutput(media=(sentinel,)))]

    async def boom(*args, **kwargs):  # pragma: no cover - must not fire
        raise AssertionError("legacy augment_with_media should not run")

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.augment_with_media",
        boom,
    )

    cards = await run_media_augmentation_phase(
        TraceData(),
        [RequestChunk(text="watch this", index=0)],
        [RouteMatch(chunk_index=0, capability="get_video", confidence=1.0)],
        executions,
        raw_text="watch this",
    )

    assert cards == [sentinel]


@pytest.mark.anyio
async def test_media_augmentation_falls_back_when_adapters_are_empty(monkeypatch):
    """Without adapter media, the legacy augmentor keeps working (and warns)."""
    captured: list[dict] = []

    async def fake_augment(chunks, routes, executions, raw_text=""):
        card = {"kind": "youtube_video", "url": "https://example.test/v=fallback"}
        captured.append(card)
        return [card]

    monkeypatch.setattr(
        "lokidoki.orchestrator.core.pipeline_phases.augment_with_media",
        fake_augment,
    )

    executions = [_exec(0, "lookup_movie", AdapterOutput())]
    cards = await run_media_augmentation_phase(
        TraceData(),
        [RequestChunk(text="some movie", index=0)],
        [RouteMatch(chunk_index=0, capability="lookup_movie", confidence=1.0)],
        executions,
        raw_text="some movie",
    )

    assert cards == captured
    assert cards[0]["url"] == "https://example.test/v=fallback"


@pytest.mark.anyio
async def test_execute_phase_uses_registry_skill_id_not_fallback_map():
    """The retired _HANDLER_TO_SKILL_ID map is gone — registry drives dispatch."""
    runtime = get_runtime()
    chunk = RequestChunk(text="1+1", index=0)
    route = RouteMatch(chunk_index=0, capability="calculate", confidence=0.9)
    implementation = runtime.select_handler(0, "calculate")
    assert implementation.skill_id == "calculator", (
        "calculator implementation must carry skill_id via the registry "
        "(chunk 5 folded the pipeline_phases fallback map into the registry)"
    )
    resolution = ResolutionResult(
        chunk_index=0,
        resolved_target="1+1",
        source="direct",
        confidence=1.0,
        params={"expression": "1+1"},
    )

    executions = await run_execute_phase(
        TraceData(), {}, runtime, [chunk], [route], [implementation], [resolution],
    )

    assert executions[0].success is True
    assert executions[0].adapter_output is not None
    assert executions[0].adapter_output.summary_candidates  # calculator fires


def test_no_decision_logic_reads_mechanism_result_data_subscript():
    """Grep invariant: no branch-on-value reads of mechanism_result.data[...]."""
    repo = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(
            ["rg", "-n", "mechanism_result.data\\[", "lokidoki/orchestrator/"],
            cwd=str(repo),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        pytest.skip("ripgrep not installed")
    # rg exits 1 when no matches; 0 when matches exist.
    assert result.returncode == 1, (
        "found mechanism_result.data[...] usages in orchestrator:\n"
        f"{result.stdout}"
    )
