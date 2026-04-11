from __future__ import annotations

import pytest

from v2.bmo_nlu.core.pipeline import run_pipeline, run_pipeline_async
from v2.bmo_nlu.pipeline.normalizer import normalize_text
from v2.bmo_nlu.pipeline.splitter import split_requests


def test_v2_normalizer_cleans_quotes_and_spaces():
    normalized = normalize_text("  “Hello”   there  ")

    assert normalized.raw_text == "  “Hello”   there  "
    assert normalized.cleaned_text == '"Hello" there'
    assert normalized.lowered_text == '"hello" there'


def test_v2_splitter_splits_obvious_compound_request():
    chunks = split_requests("what time is it and how do you spell restaurant")

    assert [chunk.text for chunk in chunks] == [
        "what time is it",
        "how do you spell restaurant",
    ]
    assert [chunk.index for chunk in chunks] == [0, 1]


def test_v2_pipeline_handles_fast_lane_spelling_request():
    result = run_pipeline("how do you spell restaurant")

    assert result.response.output_text == "restaurant"
    assert result.fast_lane.matched is True
    assert [step.name for step in result.trace.steps] == ["normalize", "signals", "fast_lane"]
    assert result.trace.steps[-1].status == "matched"
    assert result.trace.steps[-1].timing_ms >= 0.0


def test_v2_pipeline_handles_obvious_compound_request_end_to_end():
    result = run_pipeline("hello and how do you spell necessary")

    assert result.fast_lane.matched is False
    assert [chunk.text for chunk in result.chunks] == ["hello", "how do you spell necessary"]
    assert len(result.executions) == 2
    assert "hello" in result.response.output_text.lower()
    assert "necessary" in result.response.output_text.lower()
    assert result.parsed.token_count > 0
    assert len(result.extractions) == 2
    assert len(result.resolutions) == 2
    assert [step.status for step in result.trace.steps] == [
        "done",
        "done",
        "bypassed",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
    ]
    assert all(step.timing_ms >= 0.0 for step in result.trace.steps)


def test_v2_pipeline_extracts_and_resolves_chunk_context():
    result = run_pipeline("what time is it and how do you spell restaurant")

    assert result.parsed.sentences == ["what time is it and how do you spell restaurant"]
    assert result.extractions[0].references == ["time"]
    assert result.extractions[1].references == ["restaurant"]
    assert result.resolutions[0].resolved_target == "current_time"
    assert result.resolutions[1].resolved_target == "restaurant"


def test_v2_pipeline_builds_request_spec_and_trace_summary():
    result = run_pipeline("hello and how do you spell necessary")

    assert result.request_spec.original_request == "hello and how do you spell necessary"
    assert len(result.request_spec.chunks) == 2
    assert result.request_spec.chunks[0].capability == "greeting_response"
    assert result.request_spec.chunks[0].handler_name == "core.greetings.reply"
    assert result.request_spec.chunks[1].candidate_count == 2
    assert result.request_spec.chunks[1].params["resolved_target"] == "necessary"
    assert result.trace_summary.total_timing_ms >= 0.0
    assert result.trace_summary.slowest_step_name in [step.name for step in result.trace.steps]


def test_v2_pipeline_resolves_recent_movie_from_context():
    result = run_pipeline(
        "what was that movie",
        context={
            "recent_entities": [
                {"type": "movie", "name": "Dune: Part Two"},
                {"type": "person", "name": "Leia"},
            ]
        },
    )

    assert [route.capability for route in result.routes] == ["recall_recent_media"]
    assert result.resolutions[0].resolved_target == "Dune: Part Two"
    assert result.resolutions[0].source == "recent_context"
    assert result.response.output_text == "Dune: Part Two"
    assert result.request_spec.supporting_context == ["movie:Dune: Part Two"]
    assert result.request_spec.context["recent_entities"][0]["name"] == "Dune: Part Two"


def test_v2_pipeline_trace_contains_per_chunk_stage_details():
    result = run_pipeline("hello and how do you spell restaurant")

    route_step = next(step for step in result.trace.steps if step.name == "route")
    select_step = next(step for step in result.trace.steps if step.name == "select_implementation")
    resolve_step = next(step for step in result.trace.steps if step.name == "resolve")
    execute_step = next(step for step in result.trace.steps if step.name == "execute")

    assert route_step.details["chunks"][0]["capability"] == "greeting_response"
    assert route_step.details["chunks"][1]["capability"] == "spell_word"
    assert "spell restaurant" in route_step.details["chunks"][1]["matched_text"]
    assert route_step.details["chunks"][0]["timing_ms"] >= 0.0
    assert select_step.details["chunks"][1]["handler_name"] == "core.dictionary.spell"
    assert select_step.details["chunks"][1]["candidate_count"] == 2
    assert select_step.details["chunks"][1]["candidates"][0]["priority"] == 5
    assert select_step.details["chunks"][1]["timing_ms"] >= 0.0
    assert resolve_step.details["chunks"][1]["resolved_target"] == "restaurant"
    assert resolve_step.details["chunks"][1]["timing_ms"] >= 0.0
    assert execute_step.details["chunks"][1]["output_text"] == "restaurant"
    assert execute_step.details["chunks"][1]["timing_ms"] >= 0.0


@pytest.mark.anyio
async def test_v2_async_pipeline_matches_sync_shape():
    result = await run_pipeline_async("hello and how do you spell restaurant")

    assert [chunk.text for chunk in result.chunks] == ["hello", "how do you spell restaurant"]
    assert [route.capability for route in result.routes] == ["greeting_response", "spell_word"]
    assert [implementation.handler_name for implementation in result.implementations] == [
        "core.greetings.reply",
        "core.dictionary.spell",
    ]
    assert result.implementations[1].candidate_count == 2
    assert [resolution.resolved_target for resolution in result.resolutions] == ["greeting", "restaurant"]
    assert result.response.output_text.lower().startswith("hello")


@pytest.mark.anyio
async def test_v2_async_pipeline_resolves_recent_movie_from_context():
    result = await run_pipeline_async(
        "what was that movie",
        context={"recent_entities": [{"type": "movie", "name": "Padme"}]},
    )

    assert [route.capability for route in result.routes] == ["recall_recent_media"]
    assert result.resolutions[0].resolved_target == "Padme"
    assert result.request_spec.supporting_context == ["movie:Padme"]
