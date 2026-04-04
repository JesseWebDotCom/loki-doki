"""Chat-related API routes."""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from app import db
from app.classifier import classify_message
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.chat import (
    ChatRequest,
    SmartRetryRequest,
    ChatCreateRequest,
    ChatRenameRequest,
)
from app.chats import store as chat_store
from app.subsystems.memory import store as memory_store
from app.runtime import runtime_context
from app.orchestrator import route_message_stream
from app.subsystems.character import character_service
from app.api.chat_helpers import (
    assistant_message_meta,
    build_memory_context,
    chat_providers,
    generate_chat_assistant_message,
    chat_state_payload,
    resolve_response_style_policy,
    skill_render_context,
    skill_should_skip_character_render,
)
from app.skills.service import skill_service, SkillService


router = APIRouter(prefix="/chats", tags=["chats"])
compat_router = APIRouter(prefix="/chat", tags=["chat-compat"])


@router.post("")
def create_chat_api(
    payload: ChatCreateRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create one chat and return the refreshed chat state."""
    with connection_scope() as connection:
        character_id = payload.character_id or "lokidoki"
        chat = chat_store.create_chat(
            connection, 
            current_user["id"], 
            payload.title or chat_store.DEFAULT_CHAT_TITLE,
            character_id=character_id
        )
        state = chat_state_payload(connection, current_user["id"], active_chat_id=str(chat["id"]))
    return {"chat": chat, **state}


@router.post("/{chat_id}/select")
def select_chat_api(
    chat_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Set the active chat and return its history."""
    with connection_scope() as connection:
        try:
            state = chat_state_payload(connection, current_user["id"], active_chat_id=chat_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    return state


@router.patch("/{chat_id}")
def rename_chat_api(
    chat_id: str,
    payload: ChatRenameRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Update one chat title."""
    with connection_scope() as connection:
        try:
            chat = chat_store.rename_chat(connection, current_user["id"], chat_id, payload.title.strip())
            return {"chat": chat, "chats": chat_store.list_chat_summaries(connection, current_user["id"])}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{chat_id}")
def delete_chat_api(
    chat_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one chat and return the refreshed sidebar state."""
    with connection_scope() as connection:
        chat_store.delete_chat(connection, current_user["id"], chat_id)
        return chat_state_payload(connection, current_user["id"])


@router.post("/message")
async def chat_message_api(
    payload: ChatRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Process one chat turn and persist the messages."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        chat = chat_store.resolve_chat(connection, current_user["id"], payload.chat_id)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        
        user_message = {"role": "user", "content": payload.message.strip()}
        chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), user_message)
        
        # Reload history to include the user message
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        
        assistant_message = await generate_chat_assistant_message(
            connection,
            current_user,
            context["settings"]["profile"],
            history[:-1],
            context["providers"],
            payload.message.strip(),
            chat_id=str(chat["id"]),
            force_smart=(payload.performance_profile_id == "thinking"),
            response_style=payload.response_style,
        )
        chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), assistant_message)
        
        return {
            "chat_id": str(chat["id"]),
            "user_message": user_message,
            "assistant_message": assistant_message,
            "chats": chat_store.list_chat_summaries(connection, current_user["id"]),
        }


@router.post("/message/stream")
async def chat_message_stream_api(
    payload: ChatRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Stream one assistant reply turn."""
    classification = classify_message(payload.message.strip())
    turn_id = uuid4().hex
    
    # Pre-build context and providers
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        chat = chat_store.resolve_chat(connection, current_user["id"], payload.chat_id)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        active_providers = chat_providers(
            context["providers"],
            force_smart=(payload.performance_profile_id == "thinking"),
        )
        rendering_context = character_service.build_rendering_context(
            connection,
            current_user,
            context["settings"]["profile"],
            compiler_provider=active_providers["llm_thinking"],
        )
        dynamic_context = build_memory_context(
            connection,
            current_user["id"],
            payload.message.strip(),
            history,
            active_providers["llm_fast"],
            character_id=rendering_context.active_character_id if rendering_context else None,
            chat_id=str(chat["id"]),
        )
        
        user_message = {"role": "user", "content": payload.message.strip()}
        chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), user_message)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        
        # Skill routing needs to be peeked first to see if we should run a skill
        skill_route = skill_service.inspect_route(
            connection,
            APP_CONFIG,
            current_user,
            context["settings"]["profile"],
            payload.message.strip(),
            history=history,
        )

    # Resolve response style policy
    response_style_policy = resolve_response_style_policy(
        payload.message.strip(),
        history[:-1],
        classification,
        rendering_context,
        payload.response_style,
        turn_id=turn_id,
    )
    chosen_response_style = str(response_style_policy["style"])

    async def iter_events():
        import asyncio
        progress_queue = asyncio.Queue()
        
        async def emit_progress(msg: str):
            await progress_queue.put(msg) if progress_queue else None

        skill_message = None
        if skill_route:
            # 1. Execute skill with progress streaming
            connection_factory = connection_scope
            with connection_factory() as connection:
                skill_task = asyncio.create_task(
                    skill_service.route_and_execute(
                        connection,
                        APP_CONFIG,
                        current_user,
                        context["settings"]["profile"],
                        payload.message.strip(),
                        turn_id=turn_id,
                        history=history,
                        emit_progress=emit_progress,
                    )
                )

                while not skill_task.done():
                    try:
                        # Wait for a progress message or check if task finished
                        msg = await asyncio.wait_for(progress_queue.get(), timeout=0.1)
                        yield json.dumps({"type": "skill_progress", "skill": skill_route.get("skill"), "message": msg}) + "\n"
                    except asyncio.TimeoutError:
                        continue
                
                skill_message = await skill_task

        if skill_message is not None:
             # 2. Handle structured skill response (executed or clarified)
             result_payload = skill_message.get("result") or {}
             
             if skill_should_skip_character_render(skill_message["message"]):
                 reply_text = str(result_payload.get("reply") or "").strip()
                 meta_with_result = assistant_message_meta(
                    classification,
                    active_providers["llm_fast"],
                    result_payload,
                    turn_id=turn_id,
                    voice_summary=reply_text,
                    response_style=chosen_response_style,
                    response_style_debug=dict(response_style_policy.get("debug") or {}),
                 )
                 meta_with_result["skill_route"] = skill_route
                 
                 yield json.dumps({"type": "meta", "meta": meta_with_result}) + "\n"
                 yield json.dumps({"type": "delta", "delta": reply_text}) + "\n"
                 
                 with connection_scope() as conn:
                     assistant_message = {
                        "role": "assistant",
                        "content": reply_text,
                        "meta": meta_with_result,
                        "created_at": None,
                     }
                     chat_store.append_chat_message(conn, current_user["id"], str(chat["id"]), assistant_message)
                     
                     memory_store.promote_person_facts(
                        conn, 
                        current_user["id"], 
                        rendering_context.active_character_id if rendering_context else None, 
                        payload.message.strip(), 
                        history
                     )
                     
                     saved_history = chat_store.load_chat_history(conn, current_user["id"], str(chat["id"]))
                     saved_message = dict(saved_history[-1]) if saved_history else dict(assistant_message)
                 yield json.dumps({"type": "done", "message": saved_message}) + "\n"
                 return
             else:
                 # Orchestrated character render for skill result
                 _, skill_render_prompt = skill_render_context(skill_message["message"], skill_route)
                 
                 stream_result = route_message_stream(
                    payload.message.strip(),
                    current_user["display_name"],
                    context["settings"]["profile"],
                    history,
                    active_providers,
                    rendering_context=rendering_context,
                    dynamic_context=skill_render_prompt,
                    response_style=chosen_response_style,
                 )
                 
                 meta = assistant_message_meta(
                    classification,
                    active_providers["llm_fast"],
                    result_payload,
                    turn_id=turn_id,
                    response_style=chosen_response_style,
                    response_style_debug=dict(response_style_policy.get("debug") or {}),
                 )
                 meta["skill_route"] = skill_route
                 
                 chunks: list[str] = []
                 yield json.dumps({"type": "meta", "meta": meta}) + "\n"
                 try:
                     for chunk in stream_result.chunks:
                         text = str(chunk)
                         if not text:
                             continue
                         chunks.append(text)
                         yield json.dumps({"type": "delta", "delta": text}) + "\n"
                 except Exception as exc:
                     yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"
                     return

                 assistant_message = {
                     "role": "assistant",
                     "content": "".join(chunks),
                     "meta": {
                         **meta,
                         "voice_summary": "".join(chunks).strip(),
                     },
                     "created_at": None,
                 }
                 with connection_scope() as connection:
                     chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), assistant_message)
                     
                     memory_store.promote_person_facts(
                         connection,
                         current_user["id"],
                         rendering_context.active_character_id if rendering_context else None,
                         payload.message.strip(),
                         history,
                     )
                     
                     saved_history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
                     saved_message = dict(saved_history[-1]) if saved_history else dict(assistant_message)
                 yield json.dumps({"type": "done", "message": saved_message}) + "\n"
                 return

        # 3. Standard text streaming fallback
        stream_result = route_message_stream(
            payload.message.strip(),
            current_user["display_name"],
            context["settings"]["profile"],
            history[:-1],
            active_providers,
            rendering_context=rendering_context,
            dynamic_context=dynamic_context,
            response_style=chosen_response_style,
        )

        meta = assistant_message_meta(
            classification,
            active_providers["llm_fast"],
            turn_id=turn_id,
            response_style=chosen_response_style,
            response_style_debug=dict(response_style_policy.get("debug") or {}),
        )
        if skill_route is not None:
             meta["skill_route"] = skill_route

        chunks: list[str] = []
        yield json.dumps({"type": "meta", "meta": meta}) + "\n"
        try:
            for chunk in stream_result.chunks:
                text = str(chunk)
                if not text:
                    continue
                chunks.append(text)
                yield json.dumps({"type": "delta", "delta": text}) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"
            return

        assistant_message = {
            "role": "assistant",
            "content": "".join(chunks),
            "meta": {
                **meta,
                "voice_summary": "".join(chunks).strip(),
            },
            "created_at": None,
        }
        with connection_scope() as connection:
            chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), assistant_message)
            
            memory_store.promote_person_facts(
                connection,
                current_user["id"],
                rendering_context.active_character_id if rendering_context else None,
                payload.message.strip(),
                history,
            )
            
            if rendering_context and rendering_context.active_character_id:
                memory_store.extract_person_facts_llm(
                    connection,
                    active_providers["llm_fast"],
                    current_user["id"],
                    rendering_context.active_character_id,
                    payload.message.strip()
                )

            saved_history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
            saved_message = dict(saved_history[-1]) if saved_history else dict(assistant_message)
        yield json.dumps({"type": "done", "message": saved_message}) + "\n"

    return StreamingResponse(iter_events(), media_type="application/x-ndjson")


@router.post("/retry-smart")
async def retry_smart_api(
    payload: SmartRetryRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Retry one assistant turn with reasoning enabled."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        chat = chat_store.resolve_chat(connection, current_user["id"], payload.chat_id)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        
        if payload.assistant_index < 1 or payload.assistant_index >= len(history):
            raise HTTPException(status_code=400, detail="Invalid assistant message index.")
            
        user_index = payload.assistant_index - 1
        user_message = history[user_index]
        if user_message["role"] != "user":
             raise HTTPException(status_code=400, detail="Target index is not an assistant reply to a user message.")
             
        # Generate new smart reply
        assistant_message = await generate_chat_assistant_message(
            connection,
            current_user,
            context["settings"]["profile"],
            history[:user_index],
            context["providers"],
            user_message["content"],
            chat_id=str(chat["id"]),
            force_smart=True,
            response_style=payload.response_style,
        )
        chat_store.replace_chat_message(connection, current_user["id"], str(chat["id"]), payload.assistant_index, assistant_message)
        
        return {
            "chat_id": str(chat["id"]),
            "assistant_message": assistant_message,
            "assistant_index": payload.assistant_index,
        }


@compat_router.post("/stream")
async def chat_stream_alias_api(
    payload: ChatRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Compatibility alias for the legacy singular chat stream route."""
    return await chat_message_stream_api(payload, current_user)


@compat_router.post("/retry-smart")
async def retry_smart_alias_api(
    payload: SmartRetryRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Compatibility alias for the legacy singular retry-smart route."""
    return await retry_smart_api(payload, current_user)
