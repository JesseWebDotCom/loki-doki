"""Chat HTTP route.

Each turn:
  1. resolves the authenticated current user
  2. creates a new session row if the client didn't pass session_id
  3. persists the user message to the MemoryProvider (chat history)
  4. runs the pipeline via stream_pipeline_sse
  5. persists the assistant reply to the MemoryProvider
  6. streams pipeline events back as SSE
"""
from __future__ import annotations

import json
import logging
import re
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
    """Process a chat message through the pipeline, streaming SSE events."""
    from lokidoki.orchestrator.core.streaming import stream_pipeline_sse

    user_id = user.id
    session_id = request.session_id or await memory.create_session(
        user_id, project_id=request.project_id
    )

    # Check if this is the first message in the session (for auto-naming).
    existing_messages = await memory.get_messages(
        user_id=user_id, session_id=session_id, limit=1
    )
    is_first_turn = len(existing_messages) == 0

    # Persist user message to chat history.
    user_message_id = await memory.add_message(
        user_id=user_id, session_id=session_id, role="user", content=request.message,
    )

    # Resolve the active character for this user.
    resolved = await memory.run_sync(
        lambda conn: character_ops.get_active_character_for_user(conn, user_id)
    )
    behavior_prompt = (resolved or {}).get("behavior_prompt", "") if resolved else ""
    character_name = (resolved or {}).get("name", "Loki") if resolved else "Loki"
    character_id = (resolved or {}).get("id", "default") if resolved else "default"

    # Load recent conversation history for LLM context.
    recent_messages = await memory.get_messages(
        user_id=user_id, session_id=session_id, limit=12,
    )
    # Format as alternating user/assistant pairs (most recent last).
    # get_messages returns sqlite3.Row objects — convert to dict for .get().
    conversation_history: list[dict[str, str]] = []
    for msg in recent_messages:
        m = dict(msg)
        if m.get("role") in ("user", "assistant") and m.get("content"):
            conversation_history.append({"role": m["role"], "content": m["content"]})

    # Resolve user's preferred name for personalization.
    user_name = await memory.get_user_name(user_id)

    # Build pipeline context.
    context = {
        "session_id": session_id,
        "memory_writes_enabled": True,
        "memory_provider": memory,
        "user_message_id": user_message_id,
        "owner_user_id": user_id,
        "user_name": user_name,
        "behavior_prompt": behavior_prompt,
        "character_name": character_name,
        "character_id": str(character_id),
        "conversation_history": conversation_history,
    }

    async def event_stream():
        try:
            # Emit session-ready event (frontend expects this first).
            session_event = {"phase": "session", "status": "ready", "data": {"session_id": session_id}}
            yield f"data: {json.dumps(session_event, separators=(',', ':'))}\n\n"

            response_text = ""
            async for sse_chunk in stream_pipeline_sse(request.message, context=context):
                # Intercept synthesis-done to capture the final response and trigger naming.
                if '"phase"' in sse_chunk and '"synthesis"' in sse_chunk and '"status"' in sse_chunk and '"done"' in sse_chunk:
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
            num_predict=40,
            temperature=0.3,
        )
        await client.close()

        # Remove thinking tags if the model leaked them.
        clean = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        title = clean.strip().strip('"').strip("'")[:80]

        if title:
            await memory.update_session_title(user_id, session_id, title)
        else:
            logger.warning("auto-name generated empty title for session %s", session_id)
    except Exception:
        logger.exception("auto-name failed for session %s", session_id)


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
    trace_json: Optional[str] = None

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
    from lokidoki.orchestrator.registry.runtime import get_runtime
    runtime = get_runtime()
    capabilities = list(runtime.capabilities.keys())
    return {
        "skills": capabilities,
        "intents": capabilities,
    }


@router.get("/platform")
async def get_platform():
    return {
        "platform": _model_policy.profile,
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
        "platform": _model_policy.profile,
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
                memory_tags = {"no memory", "bad memory"}
                if any(tag in (request.tags or []) for tag in memory_tags):
                    # Gather context preceding this message (last 3 turns = up to 6 msgs)
                    history = []
                    # We look at messages BEFORE the current one (index i)
                    for j in range(max(0, i - 6), i):
                        m_hist = messages[j]
                        role = m_hist["role"].upper()
                        history.append(f"{role}: {m_hist['content']}")
                    prompt_text = "\n---\n".join(history)
                elif i > 0:
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
        trace=request.trace_json,
    )
    return {"status": "ok", "feedback_id": feedback_id}


@router.get("/feedback")
async def list_feedback(
    rating: Optional[int] = None,
    limit: int = 100,
    user_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """List feedback entries. Admins can see all users or a specific user."""
    target_user_id = user.id
    if user.role == 'admin':
        # Admin can choose to see a specific user or everyone (None)
        target_user_id = user_id
    elif user_id is not None and user_id != user.id:
        raise HTTPException(status_code=403, detail="forbidden_access_to_other_users_feedback")

    entries = await memory.list_message_feedback(
        user_id=target_user_id, rating=rating, limit=limit
    )
    return {"feedback": entries}


@router.delete("/feedback")
async def delete_feedback(
    user_id: Optional[int] = None,
    feedback_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Delete feedback for a user or a specific entry. Admin only."""
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail="admin_only")
    
    deleted_count = await memory.delete_message_feedback(
        user_id=user_id, feedback_id=feedback_id
    )
    return {"status": "ok", "deleted_count": deleted_count}


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
