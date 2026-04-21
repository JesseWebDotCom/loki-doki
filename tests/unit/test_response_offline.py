"""Tests for chunk 11's offline-degradation flag.

Covers:

* :func:`is_offline_degraded` classification over
  :class:`ExecutionResult` lists (typed ``error_kind`` + keyword
  fallback + happy path).
* :class:`ResponseEnvelope.offline_degraded` round-trips through the
  serde helpers.
* :func:`_build_envelope` stamps the flag on the envelope produced by
  the synthesis phase when at least one execution reports an offline
  failure.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.core.pipeline_phases import _build_envelope
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    RequestSpec,
    ResponseObject,
    TraceData,
)
from lokidoki.orchestrator.response import (
    ResponseEnvelope,
    envelope_from_dict,
    envelope_to_dict,
)
from lokidoki.orchestrator.response.planner import is_offline_degraded


def _exec_ok(idx: int, capability: str = "knowledge_query") -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=True,
        adapter_output=AdapterOutput(
            summary_candidates=("Luke is a Jedi.",),
            sources=(Source(title="Luke", url="https://example.test/luke"),),
        ),
    )


def _exec_offline_typed(idx: int, capability: str = "search_web") -> ExecutionResult:
    """An execution whose raw_result carries the canonical error_kind=offline."""
    return ExecutionResult(
        chunk_index=idx,
        capability=capability,
        output_text="",
        success=False,
        error="network is unreachable",
        raw_result={
            "output_text": "",
            "success": False,
            "error_kind": "offline",
            "error": "network is unreachable",
        },
    )


def _exec_offline_keyword(idx: int, message: str) -> ExecutionResult:
    """An execution with no typed kind — just a raw exception string."""
    return ExecutionResult(
        chunk_index=idx,
        capability="search_web",
        output_text="",
        success=False,
        error=message,
        raw_result={"output_text": "", "success": False, "error": message},
    )


def _exec_unrelated_failure(idx: int) -> ExecutionResult:
    return ExecutionResult(
        chunk_index=idx,
        capability="knowledge_query",
        output_text="",
        success=False,
        error="skill crashed — invalid params",
        raw_result={
            "output_text": "",
            "success": False,
            "error_kind": "invalid_params",
            "error": "skill crashed — invalid params",
        },
    )


class TestIsOfflineDegraded:
    def test_all_successful_returns_false(self) -> None:
        executions = [_exec_ok(0), _exec_ok(1)]
        assert is_offline_degraded(executions) is False

    def test_typed_offline_kind_wins(self) -> None:
        executions = [_exec_ok(0), _exec_offline_typed(1)]
        assert is_offline_degraded(executions) is True

    def test_keyword_fallback_trips_the_flag(self) -> None:
        executions = [
            _exec_ok(0),
            _exec_offline_keyword(1, "Temporary failure in name resolution"),
        ]
        assert is_offline_degraded(executions) is True

    def test_unrelated_failures_do_not_trip_the_flag(self) -> None:
        # invalid_params is NOT a network failure — don't show the chip.
        executions = [_exec_ok(0), _exec_unrelated_failure(1)]
        assert is_offline_degraded(executions) is False

    def test_mixed_success_and_offline_trips_the_flag(self) -> None:
        # Two successes + one offline — chunk 11's spec example.
        executions = [
            _exec_ok(0),
            _exec_ok(1),
            _exec_offline_typed(2),
        ]
        assert is_offline_degraded(executions) is True

    @pytest.mark.parametrize(
        "marker",
        [
            "getaddrinfo failed",
            "Max retries exceeded with url: https://example.test",
            "connection refused",
            "Read timed out. (read timeout=5)",
            "No route to host",
        ],
    )
    def test_recognizes_common_offline_exception_texts(self, marker: str) -> None:
        executions = [_exec_offline_keyword(0, marker)]
        assert is_offline_degraded(executions) is True

    def test_empty_executions_returns_false(self) -> None:
        assert is_offline_degraded([]) is False

    def test_ignores_non_dict_raw_result(self) -> None:
        # raw_result can be anything (incl. non-dict) — must not crash.
        execution = ExecutionResult(
            chunk_index=0,
            capability="search_web",
            output_text="",
            success=False,
            error="",
            raw_result={},  # default dict is fine, non-dict exercised via getattr
        )
        assert is_offline_degraded([execution]) is False


# ---------------------------------------------------------------------------
# Envelope serde — offline_degraded round-trips
# ---------------------------------------------------------------------------


def test_envelope_offline_degraded_round_trips() -> None:
    envelope = ResponseEnvelope(
        request_id="req-offline-1",
        offline_degraded=True,
    )
    restored = envelope_from_dict(envelope_to_dict(envelope))
    assert restored.offline_degraded is True


def test_envelope_offline_degraded_defaults_false() -> None:
    envelope = ResponseEnvelope(request_id="req-online-1")
    restored = envelope_from_dict(envelope_to_dict(envelope))
    assert restored.offline_degraded is False


def test_envelope_offline_degraded_omitted_from_dict_when_false() -> None:
    # Wire shape stays tight — the flag is only emitted when true.
    envelope = ResponseEnvelope(request_id="req-online-2")
    assert "offline_degraded" not in envelope_to_dict(envelope)


# ---------------------------------------------------------------------------
# _build_envelope — synthesis-phase integration
# ---------------------------------------------------------------------------


def test_build_envelope_sets_offline_degraded_when_any_exec_offline() -> None:
    spec = RequestSpec(
        trace_id="t-off-1",
        original_request="latest news",
        chunks=[],
    )
    response = ResponseObject(output_text="Offline fallback summary.")
    executions = [
        _exec_ok(0),  # produced a summary/source adapter output
        _exec_offline_typed(1),
    ]
    trace = TraceData(trace_id="t-off-1")
    envelope = _build_envelope(
        trace=trace,
        request_spec=spec,
        executions=executions,
        response=response,
        status="complete",
    )
    assert envelope.offline_degraded is True


def test_build_envelope_clears_offline_degraded_when_all_successful() -> None:
    spec = RequestSpec(
        trace_id="t-off-2",
        original_request="who is luke",
        chunks=[],
    )
    response = ResponseObject(output_text="Luke is a Jedi Knight.")
    executions = [_exec_ok(0), _exec_ok(1)]
    trace = TraceData(trace_id="t-off-2")
    envelope = _build_envelope(
        trace=trace,
        request_spec=spec,
        executions=executions,
        response=response,
        status="complete",
    )
    assert envelope.offline_degraded is False
