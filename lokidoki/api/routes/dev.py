"""Developer-only prototype endpoints."""
from __future__ import annotations

import json
import logging
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from lokidoki.api.dev_memory import (
    DEV_DB_PATH,
    DEV_OWNER_USER_ID,
    dump_dev_store,
    get_dev_store,
    reset_dev_store,
)
from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.orchestrator.core.types import RequestChunk, ResolutionResult, RouteMatch
from lokidoki.orchestrator.execution.executor import execute_chunk_async
from lokidoki.orchestrator.core.pipeline import run_pipeline_async
from lokidoki.orchestrator.fallbacks.llm_client import call_llm
from lokidoki.orchestrator.memory import (
    MEMORY_SUBSYSTEM_ID,
    MEMORY_SUBSYSTEM_LABEL,
    MEMORY_SUBSYSTEM_STATUS,
    MEMORY_SUBSYSTEM_TITLE,
)
from lokidoki.orchestrator.memory.slots import SLOT_SPECS, WORST_CASE_TOTAL_BUDGET
from lokidoki.orchestrator.memory.tiers import TIER_SPECS, Tier
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.routing.embeddings import FASTEMBED_MODEL

router = APIRouter()
logger = logging.getLogger(__name__)

BENCHMARK_CORPUS_DIR = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "benchmark_corpus"
)
# Defense in depth: bound the matrix so a careless dev cannot kick off
# an hour-long grid by accident. 1500 covers the full bundled corpus
# (6 categories × 20 prompts = 120) against up to ~12 configs without
# blowing the cap. Raise higher only if someone proves the UI needs it.
MATRIX_MAX_RUNS = 1500


class PipelineRunRequest(BaseModel):
    message: str
    context: dict[str, Any] = Field(default_factory=dict)
    benchmark_label: str | None = None
    llm_mode: str = "auto"
    llm_model_override: str | None = None
    user_mode_override: str | None = None
    voice_id: str | None = None
    reasoning_mode: str = "auto"
    # Memory toggles. When ``memory_enabled`` is true the dev-tools test
    # store is wired into ``context`` so the run actually exercises the
    # write + read paths. ``need_preference`` and ``need_social`` gate
    # the per-tier read slots independently. Defaults are all False so
    # the existing pipeline behavior is preserved when the dev tool
    # has memory turned off.
    memory_enabled: bool = False
    need_preference: bool = True
    need_social: bool = True
    need_session_context: bool = True
    need_episode: bool = True

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be empty")
        return value

    @field_validator("llm_mode")
    @classmethod
    def llm_mode_valid(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"auto", "system_only", "force_llm", "raw_llm"}:
            raise ValueError(
                "llm_mode must be auto, system_only, force_llm, or raw_llm"
            )
        return normalized

    @field_validator("reasoning_mode")
    @classmethod
    def reasoning_mode_valid(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"auto", "fast", "thinking"}:
            raise ValueError("reasoning_mode must be auto, fast, or thinking")
        return normalized


class SkillRunRequest(BaseModel):
    capability: str
    message: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    resolved_target: str | None = None

    @field_validator("capability")
    @classmethod
    def capability_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("capability must not be empty")
        return value.strip()


@router.get("/pipeline/status")
async def get_pipeline_status(_: User = Depends(require_admin)):
    """Return implementation status and dependency/runtime info for the pipeline."""
    runtime = get_runtime()
    embedding_backend = runtime.embedding_backend
    minilm_active = embedding_backend.name.startswith("fastembed:")

    return {
        "current_focus": "cutover complete — chat.py uses pipeline",
        "phases": [
            {
                "id": "phase_1",
                "label": "Phase 1",
                "title": "Minimal Working Pipeline",
                "status": "complete",
                "completed": [
                    "Isolated pipeline exposed in Dev Tools",
                    "spaCy single-call parser feeding split/extract/resolve",
                    "Mature fast lane (greetings, ack, time, date, spell, math) with fuzzy templates",
                    "Doc-aware splitter with subordinate-clause and predicate-family detection",
                    "Structured trace with per-step and per-chunk timing",
                ],
                "remaining": [],
            },
            {
                "id": "phase_2",
                "label": "Phase 2",
                "title": "Semantic Routing (MiniLM)",
                "status": "complete",
                "completed": [
                    "Registry-backed capability routing",
                    "Startup-built vector index",
                    "MiniLM embeddings active through fastembed when available",
                    "Matched text, confidence, and implementation selection visible in Dev Tools",
                ],
                "remaining": [
                    "Validate hardware-specific fallback behavior on all target profiles",
                ],
            },
            {
                "id": "phase_3",
                "label": "Phase 3",
                "title": "Real Resolver",
                "status": "complete",
                "completed": [
                    "Conversation-memory, people-DB, Home Assistant, movie-context adapters (in-memory)",
                    "LokiPeopleDBAdapter — read-only against the legacy people/relationships SQLite tables, viewer-scoped",
                    "LokiSmartHomeAdapter — read-only against data/smarthome_state.json",
                    "People resolver with alias + family-priority ranking",
                    "Device resolver against the Home Assistant entity registry",
                    "Pronoun resolver bound to recent entities (skipped for direct utilities)",
                    "Recent / missing / ambiguous media follow-ups surfaced in trace and RequestSpec",
                ],
                "remaining": [],
            },
            {
                "id": "phase_4",
                "label": "Phase 4",
                "title": "Parallel Execution",
                "status": "complete",
                "completed": [
                    "Pipeline runs async with asyncio.gather()",
                    "Route / resolve / execute / handler invocation offloaded via asyncio.to_thread()",
                    "Sequential-vs-parallel benchmark in CI proves real >=1.8x speedup",
                    "Streaming TraceData.subscribe() listener seam for live UI/websocket consumers",
                    "Per-step and per-chunk latency visible in Dev Tools",
                ],
                "remaining": [],
            },
            {
                "id": "phase_5",
                "label": "Phase 5",
                "title": "Gemma Fallback",
                "status": "complete",
                "completed": [
                    "decide_gemma() decision in fallbacks/gemma_fallback.py",
                    "Prompt templates for split / resolve / combine in fallbacks/prompts.py",
                    "build_split_prompt / build_resolve_prompt / build_combine_prompt helpers",
                    "HTTPProvider wired through lokidoki.core.providers.client (fallbacks/llm_client.py)",
                    "gemma_synthesize_async on the pipeline path; degrades to stub on Ollama failures and tags trace 'degraded:gemma_error'",
                    "Stub synthesizer covers unresolved + ambiguous + supporting-context paths",
                    "Subordinate-clause chunks appear in RequestSpec.chunks for the decider",
                    "RequestSpec.gemma_used + gemma_reason flags surfaced in trace",
                ],
                "remaining": [
                    "Confidence-threshold tuning against a real prompt corpus (deferred until live Gemma traffic is available)",
                ],
            },
            {
                "id": "phase_6",
                "label": "Phase 6",
                "title": "Production Hardening",
                "status": "complete",
                "completed": [
                    "Per-handler timeout + retry budget via execution.executor",
                    "HandlerError / HandlerTimeout / TransientHandlerError classes",
                    "Failures captured on ExecutionResult instead of crashing the pipeline",
                    "Streaming trace listener seam (TraceData.subscribe)",
                    "Stdlib ANSI console renderer (observability/console.attach_console_renderer) — coloured per-step output, NO_COLOR/FORCE_COLOR aware, isolates stream failures",
                    "Regression prompt fixture suite at tests/fixtures/regression_prompts.json",
                    "Parametrized regression runner driving every fixture entry through the pipeline",
                    "130+ unit + integration tests across adapters (in-memory + LokiDoki SQLite/JSON), resolvers, fast lane, prompts, Ollama client, executor resilience, linguistics, trace listener, console renderer, parallel benchmark, dev API",
                ],
                "remaining": [],
            },
        ],
        "dependencies": [
            {
                "key": "fastapi",
                "label": "FastAPI",
                "version": _package_version("fastapi"),
                "status": "running",
                "running": True,
                "detail": "Backend process is serving the Dev Tools API right now.",
            },
            {
                "key": "fastembed",
                "label": "fastembed",
                "version": _package_version("fastembed"),
                "status": "running" if minilm_active else "idle",
                "running": minilm_active,
                "detail": (
                    "Active embedding backend for semantic routing."
                    if minilm_active
                    else "Installed, but the pipeline is currently using its local fallback backend."
                ),
            },
            {
                "key": "minilm",
                "label": "MiniLM",
                "version": FASTEMBED_MODEL,
                "status": "running" if minilm_active else "fallback",
                "running": minilm_active,
                "detail": (
                    f"pipeline routing is using {embedding_backend.name} ({embedding_backend.dimensions} dimensions)."
                    if minilm_active
                    else f"MiniLM is not active; pipeline routing fell back to {embedding_backend.name}."
                ),
            },
            {
                "key": "spacy",
                "label": "spaCy",
                "version": _package_version("spacy"),
                "status": "running",
                "running": True,
                "detail": "pipeline parser calls spaCy exactly once per utterance and reuses the Doc downstream.",
            },
            {
                "key": "en_core_web_sm",
                "label": "en_core_web_sm",
                "version": _package_version("en-core-web-sm"),
                "status": "running",
                "running": True,
                "detail": "Loaded by lokidoki/orchestrator/pipeline/parser.py for tokens, POS, deps, and NER.",
            },
        ],
        "memory": _memory_status(),
    }


def _memory_status() -> dict[str, Any]:
    """Surface the memory subsystem state on the dev-tools status page.

    The memory migration is complete: one SQLite file
    (``data/lokidoki.db``), one gate-chain writer, one lazy per-tier
    reader. The dev-tools UI renders a single status block rather than
    the old per-phase breakdown.
    """
    tiers_payload = [
        {
            "tier": int(tier),
            "name": spec.name,
            "title": spec.title,
            "storage": spec.storage,
            "landing_phase": spec.landing_phase,
        }
        for tier, spec in sorted(TIER_SPECS.items(), key=lambda kv: int(kv[0]))
    ]
    slots_payload = [
        {
            "name": spec.name,
            "tier": spec.tier,
            "char_budget": spec.char_budget,
            "always_present": spec.always_present,
            "landing_phase": spec.landing_phase,
        }
        for spec in SLOT_SPECS
    ]
    return {
        "subsystem": {
            "id": MEMORY_SUBSYSTEM_ID,
            "label": MEMORY_SUBSYSTEM_LABEL,
            "title": MEMORY_SUBSYSTEM_TITLE,
            "status": MEMORY_SUBSYSTEM_STATUS,
            "summary": (
                "One SQLite file (data/lokidoki.db), one gate-chain "
                "writer (MemoryStore), one lazy per-tier reader. "
                "Memory tiers: T2 session context, T3 episodic recall, "
                "T4 user facts (FTS5+RRF+vector), T5 social graph, "
                "T6 affective (character-scoped mood window), T7a/7b "
                "procedural (behavior events, user style descriptors)."
            ),
        },
        "tiers": tiers_payload,
        "slots": {
            "specs": slots_payload,
            "worst_case_total_chars": WORST_CASE_TOTAL_BUDGET,
        },
        "scaffolding": {
            "module": "lokidoki.orchestrator.memory",
            "submodules": [
                "gates",
                "tiers",
                "predicates",
                "classifier",
                "promotion",
                "consolidation",
                "slots",
                "schema",
            ],
            "fixtures": [
                "tests/fixtures/memory_extraction_corpus.json",
                "tests/fixtures/memory_recall_corpus.json",
                "tests/fixtures/people_resolution_corpus.json",
                "tests/fixtures/persona_corpus.json",
            ],
            "regression_row_id": "memory.president_bug.who_is_the_president",
        },
    }


@router.post("/pipeline/run")
async def run_pipeline(
    request: PipelineRunRequest,
    _: User = Depends(require_admin),
):
    """Run the isolated pipeline pipeline.

    When ``memory_enabled`` is True the request context is enriched
    with the dev-tools test store and the requested per-tier need_*
    flags. The dev test store is **separate from** the production
    store at data/memory.sqlite — dev tool runs never pollute
    real user memory.
    """
    if request.llm_mode == "raw_llm":
        return await _run_raw_llm(request)
    context = dict(request.context)
    _apply_benchmark_overrides(context, request)
    if request.memory_enabled:
        context["memory_writes_enabled"] = True
        context["memory_provider"] = SimpleNamespace(store=get_dev_store())
        context["owner_user_id"] = DEV_OWNER_USER_ID
        context["need_preference"] = request.need_preference
        context["need_social"] = request.need_social
        context["need_session_context"] = request.need_session_context
        context["need_episode"] = request.need_episode
    pipeline_result = await run_pipeline_async(request.message, context=context)
    # Strip non-serializable bits (the store contains a threading RLock
    # that asdict() chokes on) BEFORE to_dict() walks the tree. We keep
    # the assembled memory_slots so the dev tools UI can show what was
    # injected into the prompt.
    spec_context = pipeline_result.request_spec.context or {}
    if "memory_provider" in spec_context:
        spec_context.pop("memory_provider", None)
    return pipeline_result.to_dict()


@router.post("/pipeline/chat")
async def pipeline_chat_stream(
    request: PipelineRunRequest,
    _: User = Depends(require_admin),
):
    """Stream pipeline results as SSE events.

    Same request shape as ``/pipeline/run`` but returns a ``text/event-stream``
    response with progressive phase events that the existing chat UI can
    consume without modification.
    """
    from lokidoki.orchestrator.core.streaming import stream_pipeline_sse

    context: dict[str, Any] = dict(request.context)
    _apply_benchmark_overrides(context, request)
    if request.memory_enabled:
        context["memory_writes_enabled"] = True
        context["memory_provider"] = SimpleNamespace(store=get_dev_store())
        context["owner_user_id"] = DEV_OWNER_USER_ID
        context["need_preference"] = request.need_preference
        context["need_social"] = request.need_social
        context["need_session_context"] = request.need_session_context
        context["need_episode"] = request.need_episode

    return StreamingResponse(
        stream_pipeline_sse(request.message, context=context),
        media_type="text/event-stream",
    )


@router.get("/memory/dump")
async def dump_memory(_: User = Depends(require_admin)):
    """Return everything in the dev-tools test memory store."""
    payload = dump_dev_store()
    return {
        "owner_user_id": DEV_OWNER_USER_ID,
        "db_path": str(DEV_DB_PATH),
        "active_facts": payload["active_facts"],
        "superseded_facts": payload["superseded_facts"],
        "people": payload["people"],
        "relationships": payload["relationships"],
        "summary": {
            "active_fact_count": len(payload["active_facts"]),
            "superseded_fact_count": len(payload["superseded_facts"]),
            "person_count": len(payload["people"]),
            "relationship_count": len(payload["relationships"]),
        },
    }


@router.post("/memory/reset")
async def reset_memory(_: User = Depends(require_admin)):
    """Wipe the dev-tools test memory store."""
    summary = reset_dev_store()
    return {
        "owner_user_id": DEV_OWNER_USER_ID,
        "db_path": str(DEV_DB_PATH),
        **summary,
    }


@router.get("/skills")
async def get_dev_skills(_: User = Depends(require_admin)):
    """Return the current capability registry plus selected handlers."""
    runtime = get_runtime()
    skills: list[dict[str, Any]] = []
    for capability, item in sorted(runtime.capabilities.items()):
        selected = runtime.select_handler(0, capability)
        implementations = sorted(
            item.get("implementations") or [],
            key=lambda entry: int(entry.get("priority", 999)),
        )
        skills.append(
            {
                "capability": capability,
                "description": item.get("description") or "",
                "examples": item.get("examples") or [],
                "selected_handler": selected.handler_name,
                "selected_implementation_id": selected.implementation_id,
                "implementations": implementations,
            }
        )
    return {"skills": skills}


@router.post("/skills/run")
async def run_dev_skill(
    request: SkillRunRequest,
    _: User = Depends(require_admin),
):
    """Run a selected capability directly through its chosen handler."""
    runtime = get_runtime()
    implementation = runtime.select_handler(0, request.capability)
    chunk = RequestChunk(text=request.message, index=0)
    route = RouteMatch(
        chunk_index=0,
        capability=request.capability,
        confidence=1.0,
        matched_text=request.capability,
    )
    resolved_target = request.resolved_target or str(request.params.get("resolved_target") or request.message)
    resolution = ResolutionResult(
        chunk_index=0,
        resolved_target=resolved_target,
        source="manual_test",
        confidence=1.0,
        params=dict(request.params),
    )
    started = time.perf_counter()
    execution = await execute_chunk_async(chunk, route, implementation, resolution)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return {
        "capability": request.capability,
        "handler_name": implementation.handler_name,
        "implementation_id": implementation.implementation_id,
        "selected_priority": implementation.priority,
        "message": request.message,
        "params": request.params,
        "resolved_target": resolved_target,
        "timing_ms": round(elapsed_ms, 3),
        "execution": {
            "success": execution.success,
            "output_text": execution.output_text,
            "error": execution.error,
            "attempts": execution.attempts,
            "raw_result": execution.raw_result,
        },
    }


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "not installed"


def _apply_benchmark_overrides(context: dict[str, Any], request: PipelineRunRequest) -> None:
    """Inject request-scoped benchmark controls into the pipeline context."""
    llm_model_override = (request.llm_model_override or "").strip()
    voice_id = (request.voice_id or "").strip()
    context["dev_benchmark"] = {
        "label": (request.benchmark_label or "").strip(),
        "llm_mode": request.llm_mode,
        "llm_model_override": llm_model_override,
        "voice_id": voice_id,
        "reasoning_mode": request.reasoning_mode,
    }
    if request.reasoning_mode != "auto":
        context["reasoning_complexity"] = request.reasoning_mode
    if request.user_mode_override:
        context["user_mode_override"] = request.user_mode_override.strip().lower()


async def _run_raw_llm(request: PipelineRunRequest) -> dict[str, Any]:
    """Bypass the pipeline and send the prompt straight to the local LLM.

    Used by the Dev Tools benchmark lab as a floor/ceiling reference
    — no parsing, routing, resolution, fast-lane, or augmentation.
    The response is shaped to match ``PipelineResult.to_dict()`` so the
    existing dev-tools UI can render it without branching.
    """
    from lokidoki.orchestrator.core.config import CONFIG
    from lokidoki.orchestrator.fallbacks.llm_client import call_llm

    model = (request.llm_model_override or "").strip() or CONFIG.llm_model
    started = time.perf_counter()
    error: str | None = None
    text = ""
    try:
        text = await call_llm(request.message, model=model)
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI per-run
        error = str(exc)
        logger.warning("raw_llm benchmark failed: %s", error)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    step_details: dict[str, Any] = {"mode": "raw_llm", "model": model}
    if error is not None:
        step_details["error"] = error
    return {
        "normalized": {
            "raw_text": request.message,
            "cleaned_text": request.message,
            "lowered_text": request.message.lower(),
        },
        "signals": {
            "interaction_signal": "none",
            "tone_signal": "neutral",
            "urgency": "low",
            "confidence": 0.0,
        },
        "fast_lane": {
            "matched": False,
            "capability": None,
            "response_text": None,
            "reason": None,
        },
        "parsed": {
            "token_count": 0,
            "tokens": [],
            "sentences": [],
            "parser": "bypassed",
            "entities": [],
            "noun_chunks": [],
        },
        "chunks": [],
        "extractions": [],
        "routes": [],
        "implementations": [],
        "resolutions": [],
        "executions": [],
        "request_spec": {
            "trace_id": "",
            "original_request": request.message,
            "chunks": [],
            "supporting_context": [],
            "context": {},
            "runtime_version": 2,
            "llm_used": True,
            "llm_reason": "raw_llm",
            "llm_model": model,
            "media": [],
            "adapter_sources": [],
        },
        "response": {"output_text": text, "spoken_text": None},
        "trace": {
            "steps": [
                {
                    "name": "llm",
                    "status": "error" if error else "done",
                    "timing_ms": elapsed_ms,
                    "details": step_details,
                }
            ],
            "trace_id": "",
            "listeners": [],
        },
        "trace_summary": {
            "total_timing_ms": elapsed_ms,
            "slowest_step_name": "llm",
            "slowest_step_timing_ms": elapsed_ms,
            "step_count": 1,
        },
        "envelope": None,
    }


# ---------------------------------------------------------------------------
# Matrix benchmark: N prompts x M configs with aggregate stats.
# ---------------------------------------------------------------------------


class MatrixPrompt(BaseModel):
    id: str
    prompt: str
    category: str | None = None
    # Optional grading spec. ``any_of`` is a list of case-insensitive
    # substrings; the output is "correct" when at least ``min_match``
    # of them appear. Prompts without ``expected`` are ungraded
    # (creative / adversarial content).
    expected: dict[str, Any] | None = None

    @field_validator("id")
    @classmethod
    def id_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("prompt id must not be empty")
        return value

    @field_validator("prompt")
    @classmethod
    def prompt_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("prompt text must not be empty")
        return value


class MatrixConfig(BaseModel):
    """One column in the comparison matrix.

    Field semantics mirror ``PipelineRunRequest`` but we re-declare them
    here so the frontend can send a lightweight per-config blob without
    the full memory-toggle surface (memory stays disabled in matrix mode).
    """

    label: str
    llm_mode: str = "auto"
    llm_model_override: str | None = None
    reasoning_mode: str = "auto"
    user_mode_override: str | None = None
    voice_id: str | None = None

    @field_validator("label")
    @classmethod
    def label_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("config label must not be empty")
        return value

    @field_validator("llm_mode")
    @classmethod
    def llm_mode_valid(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"auto", "system_only", "force_llm"}:
            raise ValueError("llm_mode must be auto, system_only, or force_llm")
        return normalized

    @field_validator("reasoning_mode")
    @classmethod
    def reasoning_mode_valid(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"auto", "fast", "thinking"}:
            raise ValueError("reasoning_mode must be auto, fast, or thinking")
        return normalized


class MatrixRequest(BaseModel):
    prompts: list[MatrixPrompt]
    configs: list[MatrixConfig]

    @field_validator("prompts")
    @classmethod
    def prompts_not_empty(cls, value: list[MatrixPrompt]) -> list[MatrixPrompt]:
        if not value:
            raise ValueError("prompts must not be empty")
        return value

    @field_validator("configs")
    @classmethod
    def configs_not_empty(cls, value: list[MatrixConfig]) -> list[MatrixConfig]:
        if not value:
            raise ValueError("configs must not be empty")
        return value


def _percentile(values: list[float], p: float) -> float:
    """Linear-interpolation percentile for small timing samples.

    Matches NumPy's default ``method='linear'`` behavior without pulling
    NumPy into the request path. Returns 0.0 on empty input so callers
    don't have to branch.
    """
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(values)
    rank = (p / 100.0) * (len(ordered) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return float(ordered[lower] * (1 - weight) + ordered[upper] * weight)


def _summarize_timings(timings: list[float], error_count: int) -> dict[str, float | int]:
    total = len(timings) + error_count
    return {
        "count": len(timings),
        "errors": error_count,
        "error_rate": (error_count / total) if total else 0.0,
        "mean_ms": (sum(timings) / len(timings)) if timings else 0.0,
        "min_ms": min(timings) if timings else 0.0,
        "max_ms": max(timings) if timings else 0.0,
        "p50_ms": _percentile(timings, 50),
        "p95_ms": _percentile(timings, 95),
    }


def _grade_output(output: str, expected: dict[str, Any] | None) -> dict[str, Any]:
    """Keyword grader: case-insensitive substring match against ``any_of``.

    Returns ``{graded, correct, matches, min_match}``. Prompts without an
    ``expected`` spec are ungraded (``graded=False``, ``correct=None``)
    so the stats layer can skip them rather than counting them wrong.
    """
    if not expected:
        return {"graded": False, "correct": None, "matches": [], "min_match": 0}
    raw_any_of = expected.get("any_of") or []
    any_of = [str(kw) for kw in raw_any_of if str(kw).strip()]
    min_match = max(1, int(expected.get("min_match") or 1))
    haystack = (output or "").lower()
    matches = [kw for kw in any_of if kw.lower() in haystack]
    return {
        "graded": True,
        "correct": len(matches) >= min_match,
        "matches": matches,
        "min_match": min_match,
    }


def _summarize_grades(runs: list[dict[str, Any]]) -> dict[str, float | int]:
    """Roll up per-run gradings into a config-level accuracy."""
    graded = [r for r in runs if r.get("graded")]
    correct = [r for r in graded if r.get("correct")]
    graded_count = len(graded)
    correct_count = len(correct)
    return {
        "graded_count": graded_count,
        "correct_count": correct_count,
        "accuracy_rate": (correct_count / graded_count) if graded_count else 0.0,
    }


def _build_matrix_context(config: MatrixConfig) -> dict[str, Any]:
    context: dict[str, Any] = {}
    context["dev_benchmark"] = {
        "label": config.label,
        "llm_mode": config.llm_mode,
        "llm_model_override": (config.llm_model_override or "").strip(),
        "voice_id": (config.voice_id or "").strip(),
        "reasoning_mode": config.reasoning_mode,
    }
    if config.reasoning_mode != "auto":
        context["reasoning_complexity"] = config.reasoning_mode
    if config.user_mode_override:
        context["user_mode_override"] = config.user_mode_override.strip().lower()
    return context


def list_benchmark_corpus_payload() -> dict[str, Any]:
    """Load every corpus JSON under BENCHMARK_CORPUS_DIR into a single payload."""
    categories: list[dict[str, Any]] = []
    if BENCHMARK_CORPUS_DIR.exists():
        for path in sorted(BENCHMARK_CORPUS_DIR.glob("*.json")):
            try:
                data = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError) as err:
                logger.warning("benchmark corpus %s failed to load: %s", path, err)
                continue
            prompts = data.get("prompts") or []
            categories.append(
                {
                    "category": data.get("category") or path.stem,
                    "description": data.get("description") or "",
                    "prompt_count": len(prompts),
                    "prompts": prompts,
                }
            )
    return {"categories": categories}


@router.get("/pipeline/corpus")
async def get_benchmark_corpus(_: User = Depends(require_admin)):
    """Return the bundled benchmark prompt corpus grouped by category."""
    return list_benchmark_corpus_payload()


@router.post("/pipeline/matrix")
async def run_benchmark_matrix(
    request: MatrixRequest,
    _: User = Depends(require_admin),
):
    """Run every prompt x config pair and return per-run + aggregate stats.

    Prompts run sequentially per config (the pipeline is not safe to
    fan out across the same process right now), but configs iterate
    independently so the caller sees per-config stats even if a later
    config errors out.
    """
    total_runs = len(request.prompts) * len(request.configs)
    if total_runs > MATRIX_MAX_RUNS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"matrix would run {total_runs} pipelines which exceeds "
                f"the safety limit of {MATRIX_MAX_RUNS}"
            ),
        )

    results: list[dict[str, Any]] = []
    for config in request.configs:
        base_context = _build_matrix_context(config)
        timings: list[float] = []
        errors = 0
        runs: list[dict[str, Any]] = []
        for prompt in request.prompts:
            context = dict(base_context)
            started = time.perf_counter()
            try:
                pipeline_result = await run_pipeline_async(prompt.prompt, context=context)
            except Exception as exc:  # noqa: BLE001 - surfaced to the UI per-run
                errors += 1
                elapsed_ms = (time.perf_counter() - started) * 1000
                grading = _grade_output("", prompt.expected)
                runs.append(
                    {
                        "prompt_id": prompt.id,
                        "prompt": prompt.prompt,
                        "category": prompt.category,
                        "error": str(exc),
                        "total_timing_ms": elapsed_ms,
                        "llm_used": False,
                        "llm_model": None,
                        "output_text": "",
                        "fast_lane_matched": False,
                        "capability": None,
                        "expected": prompt.expected,
                        "graded": grading["graded"],
                        # errors can't be "correct" — force False for graded prompts
                        # so the denominator stays accurate.
                        "correct": False if grading["graded"] else None,
                        "matches": [],
                        "min_match": grading["min_match"],
                    }
                )
                continue

            spec = pipeline_result.request_spec
            timing = pipeline_result.trace_summary.total_timing_ms
            timings.append(timing)
            primary_chunk = next(
                (chunk for chunk in spec.chunks if chunk.role == "primary_request"),
                None,
            )
            capability = primary_chunk.capability if primary_chunk else None
            output_text = pipeline_result.response.output_text or ""
            grading = _grade_output(output_text, prompt.expected)
            runs.append(
                {
                    "prompt_id": prompt.id,
                    "prompt": prompt.prompt,
                    "category": prompt.category,
                    "error": None,
                    "total_timing_ms": timing,
                    "llm_used": bool(spec.llm_used),
                    "llm_model": spec.llm_model,
                    "output_text": output_text,
                    "fast_lane_matched": pipeline_result.fast_lane.matched,
                    "capability": capability,
                    "expected": prompt.expected,
                    "graded": grading["graded"],
                    "correct": grading["correct"],
                    "matches": grading["matches"],
                    "min_match": grading["min_match"],
                }
            )

        stats = _summarize_timings(timings, errors)
        stats.update(_summarize_grades(runs))
        results.append(
            {
                "label": config.label,
                "llm_mode": config.llm_mode,
                "llm_model_override": config.llm_model_override,
                "reasoning_mode": config.reasoning_mode,
                "user_mode_override": config.user_mode_override,
                "voice_id": config.voice_id,
                "runs": runs,
                "stats": stats,
            }
        )

    return {
        "configs": results,
        "prompt_count": len(request.prompts),
        "config_count": len(request.configs),
    }


class WarmModelRequest(BaseModel):
    model: str

    @field_validator("model")
    @classmethod
    def model_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("model must not be empty")
        return value.strip()


@router.post("/llm/warm")
async def warm_llm_model(
    request: WarmModelRequest,
    _: User = Depends(require_admin),
):
    """Force a model into engine RAM with a 1-token completion.

    The local OpenAI-compat engine only warms the fast model at boot; any
    other model loads synchronously on first inference and can stall a
    benchmark by 30s+. The dev tools call this before running so the
    timings reflect steady-state rather than cold-load cost.
    """
    started = time.perf_counter()
    try:
        await call_llm(".", model=request.model)
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI so the button unblocks
        latency_ms = (time.perf_counter() - started) * 1000
        return {
            "ok": False,
            "model": request.model,
            "latency_ms": latency_ms,
            "error": str(exc),
        }
    latency_ms = (time.perf_counter() - started) * 1000
    return {
        "ok": True,
        "model": request.model,
        "latency_ms": latency_ms,
        "error": None,
    }
