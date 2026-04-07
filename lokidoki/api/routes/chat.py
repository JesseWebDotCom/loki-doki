"""Chat HTTP route — PR2: real per-user auth.

Each turn:
  1. resolves the authenticated current user
  2. creates a new session row if the client didn't pass session_id
  3. streams pipeline events back as SSE
  4. the orchestrator persists user message, extracted facts, and
     assistant reply via the shared MemoryProvider singleton
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from typing import Optional, Union

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core import character_ops
from lokidoki.core.decomposer import Decomposer
from lokidoki.core.inference import InferenceClient
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.memory_singleton import get_memory_provider  # noqa: F401 (test patch)
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor

router = APIRouter()

_registry = SkillRegistry(skills_dir="lokidoki/skills")
_registry.scan()
_model_policy = ModelPolicy()


def get_inference_client() -> InferenceClient:
    """Factory for the inference client. Patched in tests."""
    return InferenceClient()


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None
    project_id: Optional[int] = None

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be empty")
        return v


@router.post("")
async def chat(
    request: ChatRequest,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Process a chat message through the agentic pipeline, streaming SSE events."""
    user_id = user.id
    session_id = request.session_id or await memory.create_session(
        user_id, project_id=request.project_id
    )

    # Resolve the active character for this user (catalog ← per-user
    # overrides) and inject its behavior_prompt into the synthesis
    # tier only. Decomposer is constructed independently and never
    # sees this string — that's the contract from CHARACTER_SYSTEM.md
    # §2.3 ("must NOT reach the decomposer").
    resolved = await memory.run_sync(
        lambda conn: character_ops.get_active_character_for_user(conn, user_id)
    )
    behavior_prompt = (resolved or {}).get("behavior_prompt", "") if resolved else ""

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
        user_prompt=behavior_prompt,
    )

    async def event_stream():
        try:
            yield f'data: {{"phase":"session","status":"ready","data":{{"session_id":{session_id}}}}}\n\n'
            async for event in orchestrator.process(
                request.message,
                user_id=user_id,
                session_id=session_id,
                project_id=request.project_id,
                available_intents=_registry.get_all_intents(),
            ):
                yield event.to_sse()
        finally:
            await client.close()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/memory")
async def get_memory_state(
    project_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Return the current user's recent messages, sentiment, and facts."""
    user_id = user.id
    sessions = await memory.list_sessions(user_id, project_id=project_id)
    messages: list[dict] = []
    if sessions:
        # If project_id provided, messages come from the most recent session in that project
        messages = await memory.get_messages(
            user_id=user_id, session_id=sessions[0]["id"], limit=50
        )
    facts = await memory.list_facts(user_id, limit=50) # TODO: filter facts by project_id?
    sentiment = await memory.get_sentiment(user_id)
    return {"messages": messages, "sentiment": sentiment, "facts": facts, "sessions": sessions}


class SessionUpdate(BaseModel):
    title: Optional[str] = None
    project_id: Optional[int] = None


@router.patch("/sessions/{session_id}")
async def patch_session(
    session_id: int,
    request: SessionUpdate,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Update session title or move to a different project."""
    if request.title is not None:
        await memory.update_session_title(user.id, session_id, request.title)
    if request.project_id is not None:
        # project_id=-1 or similar could mean 'move out of project' (NULL)
        # but for now let's assume valid int or None.
        # Actually in JSON None usually means "don't change" if optional.
        # Let's use a convention: project_id: 0 means "remove from project".
        pid = None if request.project_id == 0 else request.project_id
        await memory.move_session_to_project(user.id, session_id, pid)
    return {"status": "ok"}


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
async def clear_memory(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Wipe the current user's chat sessions/messages."""
    await memory.clear_user_chat(user.id)
    return {"status": "ok"}


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    deleted = await memory.delete_session(user.id, session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="session_not_found")
    return {"status": "ok"}
