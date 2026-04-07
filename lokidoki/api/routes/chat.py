"""Chat HTTP route.

PR1 wires the chat endpoint directly to the new MemoryProvider. Each
turn:
  1. resolves the default user (PR1) — TODO(auth-PR2): use real auth
  2. creates a new session row if the client didn't pass session_id
  3. streams pipeline events back as SSE
  4. the orchestrator persists user message, extracted facts, and
     assistant reply via the provider as it runs

The provider is a process singleton initialised lazily on first request
and reused across calls. Tests can override ``get_memory_provider``.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from lokidoki.core.decomposer import Decomposer
from lokidoki.core.inference import InferenceClient
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor

router = APIRouter()

_registry = SkillRegistry(skills_dir="lokidoki/skills")
_registry.scan()
_model_policy = ModelPolicy()

_memory_provider: MemoryProvider | None = None


async def get_memory_provider() -> MemoryProvider:
    """Lazy singleton accessor. Patched in tests."""
    global _memory_provider
    if _memory_provider is None:
        _memory_provider = MemoryProvider(db_path="data/lokidoki.db")
        await _memory_provider.initialize()
    return _memory_provider


def get_inference_client() -> InferenceClient:
    """Factory for the inference client. Patched in tests."""
    return InferenceClient()


class ChatRequest(BaseModel):
    message: str
    session_id: int | None = None

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be empty")
        return v


@router.post("")
async def chat(request: ChatRequest):
    """Process a chat message through the agentic pipeline, streaming SSE events."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()  # TODO(auth-PR2): real user
    session_id = request.session_id or await memory.create_session(user_id)

    client = get_inference_client()
    model_manager = ModelManager(inference_client=client, policy=_model_policy)
    decomposer = Decomposer(inference_client=client, model=_model_policy.fast_model)
    orchestrator = Orchestrator(
        decomposer=decomposer,
        inference_client=client,
        memory=memory,
        model_manager=model_manager,
        registry=_registry,
        skill_executor=SkillExecutor(),
    )

    async def event_stream():
        try:
            # First event tells the client which session id was assigned.
            yield f'data: {{"phase":"session","status":"ready","data":{{"session_id":{session_id}}}}}\n\n'
            async for event in orchestrator.process(
                request.message,
                user_id=user_id,
                session_id=session_id,
                available_intents=_registry.get_all_intents(),
            ):
                yield event.to_sse()
        finally:
            await client.close()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/memory")
async def get_memory_state():
    """Return the default user's recent messages and facts (PR1 shim)."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()
    sessions = await memory.list_sessions(user_id)
    messages: list[dict] = []
    if sessions:
        messages = await memory.get_messages(
            user_id=user_id, session_id=sessions[0]["id"], limit=50
        )
    facts = await memory.list_facts(user_id, limit=50)
    return {
        "messages": messages,
        "sentiment": {},  # TODO(sentiment-PR2): re-add per-session sentiment store
        "facts": facts,
    }


@router.get("/skills")
async def get_skills():
    return {
        "skills": list(_registry.skills.keys()),
        "intents": _registry.get_all_intents(),
    }


@router.get("/platform")
async def get_platform():
    return {
        "platform": _model_policy.platform,
        "fast_model": _model_policy.fast_model,
        "thinking_model": _model_policy.thinking_model,
    }


@router.delete("/memory")
async def clear_memory():
    """No-op in PR1 — sessions are persistent. TODO(auth-PR2): per-user clear."""
    return {"status": "noop", "note": "persistent storage; deferred to PR2"}
