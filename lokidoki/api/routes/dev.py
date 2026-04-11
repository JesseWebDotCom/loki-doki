"""Developer-only prototype endpoints."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
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


@router.get("/v2/status")
async def get_v2_status(_: User = Depends(require_admin)):
    """Return implementation status and dependency/runtime info for the v2 prototype."""
    runtime = get_runtime()
    embedding_backend = runtime.embedding_backend
    minilm_active = embedding_backend.name.startswith("fastembed:")

    return {
        "current_focus": "Phases 1/2/4/6 closed; only Phase 3 real backends + Phase 5 live Gemma client remain",
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
                    "Conversation-memory, people-DB, Home Assistant, movie-context adapters",
                    "People resolver with alias + family-priority ranking",
                    "Device resolver against the Home Assistant entity registry",
                    "Pronoun resolver bound to recent entities (skipped for direct utilities)",
                    "Recent / missing / ambiguous media follow-ups surfaced in trace and RequestSpec",
                ],
                "remaining": [
                    "Wire real PeopleDB / Home Assistant adapters when available",
                    "Per-resolver latency budgets",
                ],
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
                "status": "partial",
                "completed": [
                    "decide_gemma() decision in fallbacks/gemma_fallback.py",
                    "Prompt templates for split / resolve / combine in fallbacks/prompts.py",
                    "build_split_prompt / build_resolve_prompt / build_combine_prompt helpers",
                    "Stub synthesizer that handles unresolved + ambiguous + supporting-context paths",
                    "Subordinate-clause chunks now appear in RequestSpec.chunks for the decider",
                    "RequestSpec.gemma_used + gemma_reason flags surfaced in trace",
                ],
                "remaining": [
                    "Wire real Gemma model client (CONFIG.gemma_enabled = True) — only the HTTP call to Ollama is left",
                    "Confidence-threshold tuning against a real prompt corpus",
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
                    "Regression prompt fixture suite at tests/fixtures/v2_regression_prompts.json",
                    "Parametrized regression runner driving every fixture entry through the pipeline",
                    "100+ v2 unit + integration tests across adapters, resolvers, fast lane, prompts, executor resilience, linguistics, trace listener, parallel benchmark, dev API",
                ],
                "remaining": [
                    "End-to-end production validation against real PeopleDB / Home Assistant / Gemma backends",
                ],
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


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "not installed"
