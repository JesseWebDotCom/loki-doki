"""Developer-only prototype endpoints."""
from __future__ import annotations

import time
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from v2.orchestrator.core.types import RequestChunk, ResolutionResult, RouteMatch
from v2.orchestrator.execution.executor import execute_chunk_async
from v2.orchestrator.core.pipeline import run_pipeline_async
from v2.orchestrator.registry.runtime import get_runtime
from v2.orchestrator.routing.embeddings import FASTEMBED_MODEL

router = APIRouter()


class V2RunRequest(BaseModel):
    message: str
    context: dict[str, Any] = Field(default_factory=dict)

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be empty")
        return value


class V2SkillRunRequest(BaseModel):
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


@router.get("/v2/status")
async def get_v2_status(_: User = Depends(require_admin)):
    """Return implementation status and dependency/runtime info for the v2 prototype."""
    runtime = get_runtime()
    embedding_backend = runtime.embedding_backend
    minilm_active = embedding_backend.name.startswith("fastembed:")

    return {
        "current_focus": "All six v2 phases shipped; ongoing work is real-corpus tuning + production validation",
        "phases": [
            {
                "id": "phase_1",
                "label": "Phase 1",
                "title": "Minimal Working Pipeline",
                "status": "complete",
                "completed": [
                    "Isolated v2 prototype exposed in Dev Tools",
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
                    "Real Ollama client wired through lokidoki.core.inference.InferenceClient (fallbacks/ollama_client.py)",
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
                    "Regression prompt fixture suite at tests/fixtures/v2_regression_prompts.json",
                    "Parametrized regression runner driving every fixture entry through the pipeline",
                    "130+ v2 unit + integration tests across adapters (in-memory + LokiDoki SQLite/JSON), resolvers, fast lane, prompts, Ollama client, executor resilience, linguistics, trace listener, console renderer, parallel benchmark, dev API",
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
                    "Active embedding backend for v2 semantic routing."
                    if minilm_active
                    else "Installed, but the v2 prototype is currently using its local fallback backend."
                ),
            },
            {
                "key": "minilm",
                "label": "MiniLM",
                "version": FASTEMBED_MODEL,
                "status": "running" if minilm_active else "fallback",
                "running": minilm_active,
                "detail": (
                    f"v2 routing is using {embedding_backend.name} ({embedding_backend.dimensions} dimensions)."
                    if minilm_active
                    else f"MiniLM is not active; v2 routing fell back to {embedding_backend.name}."
                ),
            },
            {
                "key": "spacy",
                "label": "spaCy",
                "version": _package_version("spacy"),
                "status": "running",
                "running": True,
                "detail": "v2 parser calls spaCy exactly once per utterance and reuses the Doc downstream.",
            },
            {
                "key": "en_core_web_sm",
                "label": "en_core_web_sm",
                "version": _package_version("en-core-web-sm"),
                "status": "running",
                "running": True,
                "detail": "Loaded by v2/orchestrator/pipeline/parser.py for tokens, POS, deps, and NER.",
            },
        ],
    }


@router.post("/v2/run")
async def run_v2_pipeline(
    request: V2RunRequest,
    _: User = Depends(require_admin),
):
    """Run the isolated v2 prototype pipeline."""
    return (await run_pipeline_async(request.message, context=request.context)).to_dict()


@router.get("/v2/skills")
async def get_v2_skills(_: User = Depends(require_admin)):
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


@router.post("/v2/skills/run")
async def run_v2_skill(
    request: V2SkillRunRequest,
    _: User = Depends(require_admin),
):
    """Run a selected v2 capability directly through its chosen handler."""
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
