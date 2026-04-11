"""Developer-only prototype endpoints."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from v2.bmo_nlu.core.pipeline import run_pipeline_async
from v2.bmo_nlu.registry.runtime import get_runtime
from v2.bmo_nlu.routing.embeddings import FASTEMBED_MODEL

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
        "current_focus": "Phase 4 offloading and Phase 3 resolver expansion",
        "phases": [
            {
                "id": "phase_1",
                "label": "Phase 1",
                "title": "Minimal Working Pipeline",
                "status": "complete",
                "completed": [
                    "Isolated v2 prototype exposed in Dev Tools",
                    "Deterministic normalize/parse/split/extract/resolve/execute/combine flow",
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
                "status": "partial",
                "completed": [
                    "Recent movie context resolution",
                    "Missing or ambiguous media follow-ups flagged instead of guessed",
                ],
                "remaining": [
                    "People resolver",
                    "Device resolver",
                    "Pronoun and 'it' referent resolution",
                    "Real adapters for conversation memory / people / media / devices",
                ],
            },
            {
                "id": "phase_4",
                "label": "Phase 4",
                "title": "Parallel Execution",
                "status": "partial",
                "completed": [
                    "Pipeline runs async with asyncio.gather()",
                    "Route / resolve / execute wrappers offload synchronous work with asyncio.to_thread()",
                    "Per-step and per-chunk latency visible in Dev Tools",
                ],
                "remaining": [
                    "Benchmark sequential vs parallel latency once real adapters are connected",
                    "Expand offloading coverage as blocking libraries are added",
                ],
            },
            {
                "id": "phase_5",
                "label": "Phase 5",
                "title": "Gemma Fallback",
                "status": "not_started",
                "completed": [],
                "remaining": [
                    "needs_gemma() routing",
                    "Split / resolve / combine fallback prompts",
                    "Trace flag showing when Gemma is used",
                ],
            },
            {
                "id": "phase_6",
                "label": "Phase 6",
                "title": "Production Hardening",
                "status": "early",
                "completed": [
                    "Prototype trace and targeted unit/integration tests exist",
                ],
                "remaining": [
                    "Retries and timeouts per skill",
                    "Richer error classes and graceful degradation",
                    "Broader regression fixtures and production validation",
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
                "status": "installed",
                "running": False,
                "detail": "Installed in the repo, but the current v2 parser path does not call spaCy yet.",
            },
            {
                "key": "en_core_web_sm",
                "label": "en_core_web_sm",
                "version": _package_version("en-core-web-sm"),
                "status": "installed",
                "running": False,
                "detail": "spaCy English model is installed, but not currently loaded by the v2 parser path.",
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
