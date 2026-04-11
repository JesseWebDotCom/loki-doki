from __future__ import annotations

from v2.bmo_nlu.core.pipeline import run_pipeline
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
    assert [step.status for step in result.trace.steps] == ["done", "done", "bypassed", "done", "done", "done", "done", "done", "done", "done"]
    assert all(step.timing_ms >= 0.0 for step in result.trace.steps)


def test_v2_pipeline_extracts_and_resolves_chunk_context():
    result = run_pipeline("what time is it and how do you spell restaurant")

    assert result.parsed.sentences == ["what time is it and how do you spell restaurant"]
    assert result.extractions[0].references == ["time"]
    assert result.extractions[1].references == ["restaurant"]
    assert result.resolutions[0].resolved_target == "current_time"
    assert result.resolutions[1].resolved_target == "restaurant"
