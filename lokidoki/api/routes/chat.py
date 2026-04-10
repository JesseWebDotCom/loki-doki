"""Chat HTTP route — PR2: real per-user auth.

Each turn:
  1. resolves the authenticated current user
  2. creates a new session row if the client didn't pass session_id
  3. streams pipeline events back as SSE
  4. the orchestrator persists user message, extracted facts, and
     assistant reply via the shared MemoryProvider singleton
"""
from __future__ import annotations

from pathlib import Path

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
    character_name = (resolved or {}).get("name", "Loki") if resolved else "Loki"

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
        character_name=character_name,
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
                user_display_name=user.username,
            ):
                yield event.to_sse()
        except Exception:
            # If anything in the pipeline crashes, emit an error event
            # so the frontend can display a real message instead of the
            # generic "No response received" fallback.
            import logging
            import traceback
            logging.getLogger(__name__).exception(
                "[chat] pipeline crashed for user %s session %s",
                user_id, session_id,
            )
            import json
            err_event = json.dumps({
                "phase": "synthesis",
                "status": "done",
                "data": {
                    "response": "Something went wrong on my end. Check the backend logs for details.",
                    "model": "error",
                    "latency_ms": 0,
                    "tone": "neutral",
                    "sources": [],
                    "error": True,
                },
            })
            yield f"data: {err_event}\n\n"
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


class FeedbackRequest(BaseModel):
    rating: int  # 1 = positive, -1 = negative
    comment: str = ""
    tags: list[str] = []

    @field_validator("rating")
    @classmethod
    def rating_valid(cls, v: int) -> int:
        if v not in (1, -1):
            raise ValueError("rating must be 1 (positive) or -1 (negative)")
        return v


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


@router.get("/system-info")
async def get_system_info():
    """Return runtime diagnostics: platform, models, Ollama, hardware."""
    import asyncio
    from lokidoki.core.metrics import collect as collect_metrics

    client = get_inference_client()
    ollama_version = ""
    available_models: list[dict] = []
    loaded_models: list[dict] = []
    ollama_ok = False
    try:
        vr = await client._client.get("/api/version")
        if vr.status_code == 200:
            ollama_version = vr.json().get("version", "")
            ollama_ok = True
    except Exception:
        pass
    try:
        tr = await client._client.get("/api/tags")
        if tr.status_code == 200:
            for m in tr.json().get("models", []):
                available_models.append({
                    "name": m.get("name", ""),
                    "size": m.get("size", 0),
                    "parameter_size": m.get("details", {}).get("parameter_size", ""),
                    "quantization": m.get("details", {}).get("quantization_level", ""),
                    "family": m.get("details", {}).get("family", ""),
                    "modified_at": m.get("modified_at", ""),
                })
    except Exception:
        pass
    try:
        pr = await client._client.get("/api/ps")
        if pr.status_code == 200:
            for m in pr.json().get("models", []):
                loaded_models.append({
                    "name": m.get("name", ""),
                    "size": m.get("size", 0),
                    "size_vram": m.get("size_vram", 0),
                    "expires_at": m.get("expires_at", ""),
                })
    except Exception:
        pass
    await client._client.aclose()

    # Collect hardware metrics off the event loop (subprocess calls).
    hw = await asyncio.to_thread(collect_metrics, Path("data"))

    # Internet connectivity check — quick HEAD to a reliable endpoint.
    internet_ok = False
    try:
        check = await client._client.head("https://1.1.1.1", timeout=3.0)
        internet_ok = check.status_code < 500
    except Exception:
        # Client was closed above; use a fresh one for the check.
        import httpx
        try:
            async with httpx.AsyncClient(timeout=3.0) as tmp:
                check = await tmp.head("https://1.1.1.1")
                internet_ok = check.status_code < 500
        except Exception:
            pass

    return {
        "platform": _model_policy.platform,
        "fast_model": _model_policy.fast_model,
        "thinking_model": _model_policy.thinking_model,
        "ollama_version": ollama_version,
        "ollama_ok": ollama_ok,
        "internet_ok": internet_ok,
        "available_models": available_models,
        "loaded_models": loaded_models,
        **hw,
    }


@router.post("/messages/{message_id}/feedback")
async def submit_feedback(
    message_id: int,
    request: FeedbackRequest,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Submit or update thumbs-up / thumbs-down feedback for a message."""
    # Fetch response text
    response_msg = await memory.get_message(user_id=user.id, message_id=message_id)
    response_text = response_msg["content"] if response_msg else None
    
    # Fetch prompt text (the message immediately before the response in the same session)
    prompt_text = None
    if response_msg:
        session_id = response_msg["session_id"]
        messages = await memory.get_messages(user_id=user.id, session_id=session_id)
        # Find the response_msg in the list and get the one before it
        for i, m in enumerate(messages):
            if m["id"] == message_id:
                if i > 0:
                    prompt_text = messages[i-1]["content"]
                break

    feedback_id = await memory.upsert_message_feedback(
        user_id=user.id,
        message_id=message_id,
        rating=request.rating,
        comment=request.comment,
        tags=request.tags,
        prompt=prompt_text,
        response=response_text,
    )
    return {"status": "ok", "feedback_id": feedback_id}


@router.get("/feedback")
async def list_feedback(
    rating: Optional[int] = None,
    limit: int = 100,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """List feedback entries for the current user, optionally filtered by rating."""
    entries = await memory.list_message_feedback(
        user_id=user.id, rating=rating, limit=limit
    )
    return {"feedback": entries}


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
