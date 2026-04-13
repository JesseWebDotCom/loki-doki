"""Developer-only prototype endpoints."""
from __future__ import annotations

import time
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from fastapi import APIRouter, Depends
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
from lokidoki.orchestrator.memory import (
    ACTIVE_PHASE_ID,
    ACTIVE_PHASE_LABEL,
    ACTIVE_PHASE_STATUS,
    ACTIVE_PHASE_TITLE,
)
from lokidoki.orchestrator.memory.slots import SLOT_SPECS, WORST_CASE_TOTAL_BUDGET
from lokidoki.orchestrator.memory.tiers import TIER_SPECS, Tier
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.routing.embeddings import FASTEMBED_MODEL

router = APIRouter()


class PipelineRunRequest(BaseModel):
    message: str
    context: dict[str, Any] = Field(default_factory=dict)
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
        "current_focus": "cutover complete — chat.py uses pipeline; v1 orchestrator retired",
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

    M0 publishes scaffolding only — the gates, classifier, promotion, and
    consolidation modules import cleanly but contain stub logic. The phase
    list mirrors `docs/MEMORY_DESIGN.md` §8 so the dev-tools UI tracks the
    same milestones the design doc does.
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
        "active_phase": {
            "id": ACTIVE_PHASE_ID,
            "label": ACTIVE_PHASE_LABEL,
            "title": ACTIVE_PHASE_TITLE,
            "status": ACTIVE_PHASE_STATUS,
            "summary": (
                "All memory phases (M0-M6) complete. The pipeline is "
                "now the production chat path — chat.py calls "
                "stream_pipeline_sse instead of the v1 Orchestrator. "
                "Memory tiers: T2 session context, T3 episodic recall, "
                "T4 user facts (FTS5+RRF+vector), T5 social graph, "
                "T6 affective (character-scoped mood window), T7a/7b "
                "procedural (behavior events, user style descriptors). "
                "The memory store at data/memory.sqlite is "
                "initialized at app startup; the v1 MemoryProvider "
                "still owns chat history, auth, and settings."
            ),
            "deliverables": [
                "Dev tools: Enable-memory toggle + need_preference + need_social",
                "Dev tools: MemoryPanel showing facts/people/relationships + Reset",
                "Dev tools: Memory activity card on every run (writes/reads/slot contents)",
                "Dev tools: separate dev SQLite at data/dev_memory.sqlite (prod untouched)",
                "Endpoints: GET /dev/memory/dump and POST /dev/memory/reset",
                "Gate 2 carve-out: identity-establishing predicates allow new persons",
                "Extractor patterns: my favorite X is Y, I live in X, I work at X (in addition to existing copular/possessive patterns)",
                "M2.5: facts.embedding column populated on insert via routing embedding backend",
                "M2.5: _vector_search adds cosine similarity as third RRF source",
                "M2.5: vocabulary-bridge cases (foods <-> dietary restriction) recall correctly",
                "M3.5: _maybe_promote_provisional_by_relation auto-merges across turns",
                "M3.5: 9 phase tests + end-to-end pipeline merge case",
                "Public-figure stranger guard: 'the president' / 'some random guy' denied",
            ],
        },
        "phases": [
            {"id": "m0", "label": "M0", "title": "Prerequisites and corpora", "status": "complete"},
            {"id": "m1", "label": "M1", "title": "Write path: gates + classifier + Tier 4/5 writes", "status": "complete"},
            {"id": "m2", "label": "M2", "title": "Read path: Tier 4 FTS5 + RRF retrieval", "status": "complete"},
            {"id": "m2_5", "label": "M2.5", "title": "Vector embeddings as third RRF source", "status": "complete"},
            {"id": "m3", "label": "M3", "title": "Tier 5 social: people graph + provisional handles", "status": "complete"},
            {"id": "m3_5", "label": "M3.5", "title": "Auto-merge by relation", "status": "complete"},
            {"id": "m4", "label": "M4", "title": "Tier 2 + Tier 3: session state + episodic + promotion", "status": "complete"},
            {"id": "m5", "label": "M5", "title": "Tier 7 procedural: behavior events + 7a/7b split", "status": "complete"},
            {"id": "m6", "label": "M6", "title": "Tier 6 affective: rolling window + character overlay", "status": "complete"},
        ],
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
    context = dict(request.context)
    if request.memory_enabled:
        context["memory_writes_enabled"] = True
        context["memory_store"] = get_dev_store()
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
    if "memory_store" in spec_context:
        spec_context.pop("memory_store", None)
    return pipeline_result.to_dict()


@router.post("/pipeline/chat")
async def pipeline_chat_stream(
    request: PipelineRunRequest,
    _: User = Depends(require_admin),
):
    """Stream pipeline results as SSE events (v1-frontend-compatible).

    Same request shape as ``/pipeline/run`` but returns a ``text/event-stream``
    response with progressive phase events that the existing chat UI can
    consume without modification.
    """
    from lokidoki.orchestrator.core.streaming import stream_pipeline_sse

    context: dict[str, Any] = dict(request.context)
    if request.memory_enabled:
        context["memory_writes_enabled"] = True
        context["memory_store"] = get_dev_store()
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
