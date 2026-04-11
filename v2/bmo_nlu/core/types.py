"""Typed models for the v2 prototype pipeline."""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class NormalizedInput:
    raw_text: str
    cleaned_text: str
    lowered_text: str


@dataclass(slots=True)
class InteractionSignalResult:
    interaction_signal: str = "none"
    tone_signal: str = "neutral"
    urgency: str = "low"
    confidence: float = 0.0


@dataclass(slots=True)
class FastLaneResult:
    matched: bool
    capability: str | None = None
    response_text: str | None = None
    reason: str | None = None


@dataclass(slots=True)
class RequestChunk:
    text: str
    index: int
    role: str = "primary_request"


@dataclass(slots=True)
class ParsedInput:
    token_count: int
    tokens: list[str]
    sentences: list[str]


@dataclass(slots=True)
class ChunkExtraction:
    chunk_index: int
    references: list[str] = field(default_factory=list)
    predicates: list[str] = field(default_factory=list)
    subject_candidates: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RouteMatch:
    chunk_index: int
    capability: str
    confidence: float
    matched_text: str = ""


@dataclass(slots=True)
class ResolutionResult:
    chunk_index: int
    resolved_target: str
    source: str
    confidence: float


@dataclass(slots=True)
class ExecutionResult:
    chunk_index: int
    capability: str
    output_text: str


@dataclass(slots=True)
class ResponseObject:
    output_text: str


@dataclass(slots=True)
class RequestChunkResult:
    text: str
    role: str
    capability: str
    confidence: float
    params: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] = field(default_factory=dict)
    success: bool = True
    error: str | None = None
    unresolved: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RequestSpec:
    trace_id: str
    original_request: str
    chunks: list[RequestChunkResult] = field(default_factory=list)
    supporting_context: list[str] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)
    runtime_version: int = 2


@dataclass(slots=True)
class TraceStep:
    name: str
    status: str = "done"
    timing_ms: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class TraceSummary:
    total_timing_ms: float = 0.0
    slowest_step_name: str = ""
    slowest_step_timing_ms: float = 0.0
    step_count: int = 0


@dataclass(slots=True)
class TraceData:
    steps: list[TraceStep] = field(default_factory=list)

    def add(
        self,
        name: str,
        *,
        status: str = "done",
        timing_ms: float = 0.0,
        **details: Any,
    ) -> None:
        self.steps.append(
            TraceStep(
                name=name,
                status=status,
                timing_ms=round(timing_ms, 3),
                details=details,
            )
        )

    def timed(self, name: str):
        start = time.perf_counter()

        def finish(*, status: str = "done", **details: Any) -> None:
            elapsed_ms = (time.perf_counter() - start) * 1000
            self.add(name, status=status, timing_ms=elapsed_ms, **details)

        return finish


@dataclass(slots=True)
class PipelineResult:
    normalized: NormalizedInput
    signals: InteractionSignalResult
    fast_lane: FastLaneResult
    parsed: ParsedInput
    chunks: list[RequestChunk]
    extractions: list[ChunkExtraction]
    routes: list[RouteMatch]
    resolutions: list[ResolutionResult]
    executions: list[ExecutionResult]
    request_spec: RequestSpec
    response: ResponseObject
    trace: TraceData
    trace_summary: TraceSummary

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
