"""Chat HTTP route — v2 pipeline cutover.

Each turn:
  1. resolves the authenticated current user
  2. creates a new session row if the client didn't pass session_id
  3. persists the user message to the v1 MemoryProvider (chat history)
  4. runs the v2 pipeline via stream_pipeline_sse
  5. persists the assistant reply to v1 MemoryProvider
  6. streams pipeline events back as SSE
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core import character_ops
from lokidoki.core.inference import InferenceClient
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.memory_singleton import get_memory_provider  # noqa: F401 (test patch)
from lokidoki.core.model_manager import ModelPolicy
from lokidoki.core.v2_memory_singleton import get_v2_memory_store

logger = logging.getLogger(__name__)

router = APIRouter()

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
    """Process a chat message through the v2 pipeline, streaming SSE events."""
    from v2.orchestrator.core.streaming import stream_pipeline_sse

    user_id = user.id
    session_id = request.session_id or await memory.create_session(
        user_id, project_id=request.project_id
    )

    # Check if this is the first message in the session (for auto-naming).
    existing_messages = await memory.get_messages(
        user_id=user_id, session_id=session_id, limit=1
    )
    is_first_turn = len(existing_messages) == 0

    # Persist user message to v1 chat history.
    await memory.add_message(
        user_id=user_id, session_id=session_id, role="user", content=request.message,
    )

    # Resolve the active character for this user.
    resolved = await memory.run_sync(
        lambda conn: character_ops.get_active_character_for_user(conn, user_id)
    )
    behavior_prompt = (resolved or {}).get("behavior_prompt", "") if resolved else ""
    character_name = (resolved or {}).get("name", "Loki") if resolved else "Loki"
    character_id = (resolved or {}).get("id", "default") if resolved else "default"

    # Build v2 pipeline context.
    v2_store = get_v2_memory_store()
    context = {
        "memory_writes_enabled": True,
        "memory_store": v2_store,
        "owner_user_id": user_id,
        "behavior_prompt": behavior_prompt,
        "character_name": character_name,
        "character_id": str(character_id),
    }

    async def event_stream():
        try:
            # Emit session-ready event (frontend expects this first).
            yield f'data: {{"phase":"session","status":"ready","data":{{"session_id":{session_id}}}}}\n\n'

            response_text = ""
            async for sse_chunk in stream_pipeline_sse(request.message, context=context):
                # Intercept synthesis done to capture the response.
                if '"phase":"synthesis"' in sse_chunk and '"status":"done"' in sse_chunk:
                    try:
                        payload = json.loads(sse_chunk.removeprefix("data: ").rstrip("\n"))
                        response_text = payload.get("data", {}).get("response", "")
                    except (json.JSONDecodeError, AttributeError):
                        pass

                    # Persist assistant message and inject assistant_message_id.
                    asst_msg_id = None
                    if response_text:
                        asst_msg_id = await memory.add_message(
                            user_id=user_id,
                            session_id=session_id,
                            role="assistant",
                            content=response_text,
                        )
                        # Auto-name session on first turn.
                        if is_first_turn:
                            await _auto_name_session(memory, user_id, session_id, request.message)

                    # Re-emit the event with assistant_message_id injected.
                    try:
                        payload = json.loads(sse_chunk.removeprefix("data: ").rstrip("\n"))
                        payload.setdefault("data", {})["assistant_message_id"] = asst_msg_id
                        yield f"data: {json.dumps(payload)}\n\n"
                    except (json.JSONDecodeError, AttributeError):
                        yield sse_chunk
                else:
                    yield sse_chunk

        except Exception:
            logger.exception(
                "[chat] pipeline crashed for user %s session %s",
                user_id, session_id,
            )
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

    return StreamingResponse(event_stream(), media_type="text/event-stream")


async def _auto_name_session(
    memory: MemoryProvider,
    user_id: int,
    session_id: int,
    first_input: str,
) -> None:
    """Generate a 3-5 word title for the session based on the first prompt."""
    prompt = (
        f"Summarize the following short user prompt into a 3-5 word title. "
        f"Output ONLY the title, no quotes or preamble.\n\n"
        f"PROMPT: {first_input}\n"
        f"TITLE:"
    )
    try:
        client = get_inference_client()
        raw = await client.generate(
            model=_model_policy.fast_model,
            prompt=prompt,
            num_predict=20,
            temperature=0.3,
            think=False,
        )
        await client.close()
        title = raw.strip().strip('"').strip("'")[:80]
        if title:
            await memory.update_session_title(user_id, session_id, title)
    except Exception:
        logger.debug("auto-name failed for session %s, ignoring", session_id)


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
        messages = await memory.get_messages(
            user_id=user_id, session_id=sessions[0]["id"], limit=50
        )
    facts = await memory.list_facts(user_id, limit=50)
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
        pid = None if request.project_id == 0 else request.project_id
        await memory.move_session_to_project(user.id, session_id, pid)
    return {"status": "ok"}


@router.get("/skills")
async def get_skills():
    from lokidoki.core.registry import SkillRegistry
    _registry = SkillRegistry(skills_dir="lokidoki/skills")
    _registry.scan()
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
    from pathlib import Path
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

    hw = await asyncio.to_thread(collect_metrics, Path("data"))

    internet_ok = False
    try:
        check = await client._client.head("https://1.1.1.1", timeout=3.0)
        internet_ok = check.status_code < 500
    except Exception:
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
    response_msg = await memory.get_message(user_id=user.id, message_id=message_id)
    response_text = response_msg["content"] if response_msg else None

    prompt_text = None
    if response_msg:
        session_id = response_msg["session_id"]
        messages = await memory.get_messages(user_id=user.id, session_id=session_id)
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
