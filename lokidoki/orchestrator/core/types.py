"""Typed models for the pipeline pipeline."""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from lokidoki.orchestrator.adapters.base import AdapterOutput
    from lokidoki.orchestrator.response import ResponseEnvelope


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
    span_start: int = 0
    span_end: int = 0


@dataclass(slots=True)
class ParsedInput:
    token_count: int
    tokens: list[str]
    sentences: list[str]
    parser: str = "regex"
    doc: Any | None = None
    entities: list[tuple[str, str]] = field(default_factory=list)
    noun_chunks: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ChunkExtraction:
    chunk_index: int
    references: list[str] = field(default_factory=list)
    predicates: list[str] = field(default_factory=list)
    subject_candidates: list[str] = field(default_factory=list)
    entities: list[tuple[str, str]] = field(default_factory=list)


@dataclass(slots=True)
class ConstraintResult:
    budget_max: float | None = None
    time_constraint: str | None = None
    is_comparison: bool = False
    is_recommendation: bool = False
    negations: list[str] = field(default_factory=list)
    quantity: str | None = None


@dataclass(slots=True)
class RouteMatch:
    chunk_index: int
    capability: str
    confidence: float
    matched_text: str = ""
    resolved_query: str = ""


@dataclass(slots=True)
class ImplementationSelection:
    chunk_index: int
    capability: str
    handler_name: str
    implementation_id: str
    priority: int
    candidate_count: int = 0
    skill_id: str = ""


@dataclass(slots=True)
class ResolutionResult:
    chunk_index: int
    resolved_target: str
    source: str
    confidence: float
    context_value: str | None = None
    candidate_values: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    unresolved: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ExecutionResult:
    chunk_index: int
    capability: str
    output_text: str
    success: bool = True
    error: str | None = None
    attempts: int = 1
    handler_name: str = ""
    raw_result: dict[str, Any] = field(default_factory=dict)
    adapter_output: AdapterOutput | None = None


@dataclass(slots=True)
class ResponseObject:
    output_text: str
    # Chunk 16: short spoken version emitted from the SAME synthesis
    # call as ``output_text`` (design §20.3 — never a second LLM pass).
    # ``None`` means the synthesizer did not produce a dedicated spoken
    # form; :func:`lokidoki.orchestrator.response.spoken.resolve_spoken_text`
    # falls back to a trimmed summary at envelope-build time.
    spoken_text: str | None = None


@dataclass(slots=True)
class RequestChunkResult:
    text: str
    role: str
    capability: str
    confidence: float
    handler_name: str = ""
    implementation_id: str = ""
    candidate_count: int = 0
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
    llm_used: bool = False
    llm_reason: str | None = None
    # Exact Ollama model tag that produced the synthesized response.
    # Set inside ``llm_synthesize_async`` when the real model path
    # runs; ``None`` when the deterministic stub answered (the test /
    # dev mode where ``CONFIG.llm_enabled`` is False). Surfaced via
    # the API so the dev tools UI can show which model is actually
    # being used.
    llm_model: str | None = None
    # Up to 3 media cards attached by the media augmentor (YouTube,
    # Spotify, images). Rendered as a MediaBar above the assistant
    # text. Never fed to the synthesis prompt — pure UI augmentation.
    media: list[dict[str, Any]] = field(default_factory=list)
    # Canonical per-turn source list, aggregated from every successful
    # execution's ``AdapterOutput.sources``. Populated by
    # :func:`lokidoki.orchestrator.core.pipeline_phases.run_synthesis_phase`
    # before the LLM decision runs. ``_collect_sources`` in the prompt
    # builder prefers this list when present, falling back to the legacy
    # per-chunk ``result.sources`` scrape when empty.
    adapter_sources: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class TraceStep:
    name: str
    status: str = "done"
    timing_ms: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TraceSummary:
    total_timing_ms: float = 0.0
    slowest_step_name: str = ""
    slowest_step_timing_ms: float = 0.0
    step_count: int = 0


@dataclass(slots=True)
class TraceData:
    steps: list[TraceStep] = field(default_factory=list)
    trace_id: str = ""
    # Subscribers receive each :class:`TraceStep` as it is added so the
    # Dev Tools UI / websocket / CLI renderer can stream live progress.
    listeners: list[Any] = field(default_factory=list)

    def add(
        self,
        name: str,
        *,
        status: str = "done",
        timing_ms: float = 0.0,
        **details: Any,
    ) -> None:
        step = TraceStep(
            name=name,
            status=status,
            timing_ms=round(timing_ms, 3),
            details=details,
        )
        self.steps.append(step)
        for listener in self.listeners:
            try:
                listener(step)
            except Exception:  # noqa: BLE001 - listener errors must not break the trace
                continue

    def subscribe(self, listener: Any) -> None:
        """Register a callable invoked with each new :class:`TraceStep`."""
        self.listeners.append(listener)

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
    implementations: list[ImplementationSelection]
    resolutions: list[ResolutionResult]
    executions: list[ExecutionResult]
    request_spec: RequestSpec
    response: ResponseObject
    trace: TraceData
    trace_summary: TraceSummary
    # Canonical rich-response envelope for this turn. Populated by
    # :func:`lokidoki.orchestrator.core.pipeline_phases.run_synthesis_phase`
    # alongside the legacy ``response`` object. ``None`` on fast-lane
    # turns where the synthesis phase is bypassed entirely. Chunk 9
    # begins streaming envelope-level SSE events; until then the
    # envelope is only consumed by persistence and history replay.
    envelope: ResponseEnvelope | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
