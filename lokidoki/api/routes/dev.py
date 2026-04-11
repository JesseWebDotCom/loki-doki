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
from v2.orchestrator.memory import (
    ACTIVE_PHASE_ID,
    ACTIVE_PHASE_LABEL,
    ACTIVE_PHASE_STATUS,
    ACTIVE_PHASE_TITLE,
)
from v2.orchestrator.memory.slots import SLOT_SPECS, WORST_CASE_TOTAL_BUDGET
from v2.orchestrator.memory.tiers import TIER_SPECS, Tier
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
        "memory": _v2_memory_status(),
    }


def _v2_memory_status() -> dict[str, Any]:
    """Surface the v2 memory subsystem state on the dev-tools status page.

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
                "M1 is shipped: the v2 write path is live for Tier 4 "
                "(semantic-self) and Tier 5 (social). The five-gate chain "
                "(clause_shape → subject → predicate → schema → intent) "
                "denies the president bug at clause_shape, the deterministic "
                "tier classifier routes self-assertions to Tier 4 and "
                "person/handle assertions to Tier 5, immediate-durable "
                "predicates (allergies, names, pronouns) write on the first "
                "observation, single-value predicates (lives_in, current_employer, "
                "favorite_*) supersede prior values to confidence floor 0.1, and "
                "provisional handles (\"my boss\") merge into named rows when "
                "the user later names them. Memory writes are opt-in via "
                "context['memory_writes_enabled'] so the existing v2 regression "
                "suite is unaffected. The v2 store lives in its own SQLite file "
                "(data/v2_memory.sqlite) — zero shared mutable state with v1."
            ),
            "deliverables": [
                "Layer 1 gate chain: 5 gates with parse-tree clause-shape detection",
                "Layer 2 deterministic tier classifier",
                "Layer 3 promotion stub (no-op until M4)",
                "Immediate-durable bypass for safety-critical predicates",
                "Single-value predicate supersession (recency-weighted)",
                "Provisional-handle write + merge logic",
                "Cross-user isolation enforced by owner_user_id everywhere",
                "Tier 4/5 writes via V2MemoryStore (own SQLite file)",
                "131-case extraction corpus (50 should-write / 51 should-not / 20 ambiguous / 10 multi-clause)",
                "M1 phase-gate tests: precision >= 0.98, recall >= 0.70, latency < 50ms median",
                "Pipeline integration: memory_write step (opt-in, no-op when disabled)",
            ],
        },
        "phases": [
            {"id": "m0", "label": "M0", "title": "Prerequisites and corpora", "status": "complete"},
            {"id": "m1", "label": "M1", "title": "Write path: gates + classifier + Tier 4/5 writes", "status": "complete"},
            {"id": "m2", "label": "M2", "title": "Read path: Tier 4 retrieval, delete substring heuristics", "status": "not_started"},
            {"id": "m3", "label": "M3", "title": "Tier 5 social: people graph + provisional handles", "status": "not_started"},
            {"id": "m4", "label": "M4", "title": "Tier 2 + Tier 3: session state + episodic + promotion", "status": "not_started"},
            {"id": "m5", "label": "M5", "title": "Tier 7 procedural: behavior events + 7a/7b split", "status": "not_started"},
            {"id": "m6", "label": "M6", "title": "Tier 6 affective: rolling window + character overlay", "status": "not_started"},
        ],
        "tiers": tiers_payload,
        "slots": {
            "specs": slots_payload,
            "worst_case_total_chars": WORST_CASE_TOTAL_BUDGET,
        },
        "scaffolding": {
            "module": "v2.orchestrator.memory",
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
                "tests/fixtures/v2_memory_extraction_corpus.json",
                "tests/fixtures/v2_memory_recall_corpus.json",
                "tests/fixtures/v2_people_resolution_corpus.json",
                "tests/fixtures/v2_persona_corpus.json",
            ],
            "regression_row_id": "memory.president_bug.who_is_the_president",
        },
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
