"""Memory-related API routes."""

from __future__ import annotations

import json
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from app.chats import store as chat_store
from app.deps import connection_scope, get_current_user, enforce_admin
from app.models.memory import (
    MemoryAddRequest,
    MemorySyncRequest,
    MemoryWriteRequest,
)
from app.subsystems.memory import store as memory_store

router = APIRouter(prefix="/memory", tags=["memory"])


def _require_owned_chat(
    connection: Any,
    user_id: str,
    chat_id: Optional[str],
) -> str:
    """Return one owned chat id or raise an HTTP error."""
    cleaned = str(chat_id or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="chat_id is required for session memory.")
    if chat_store.get_chat_summary(connection, user_id, cleaned) is None:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return cleaned


def _memory_response(
    connection: Any,
    *,
    scope: str,
    user_id: str,
    chat_id: Optional[str] = None,
    character_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return a consistent payload for one scoped memory query."""
    memories = memory_store.list_memory(
        connection,
        scope,
        user_id,
        chat_id=chat_id,
        character_id=character_id,
    )
    return {"ok": True, "scope": scope, "memories": memories}


def _memory_context_response(
    connection: Any,
    *,
    user_id: str,
    chat_id: Optional[str] = None,
    character_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return the exact memory blocks currently available for prompt injection."""
    session_context = memory_store.get_session_context(connection, chat_id) if chat_id else ""
    long_term_context = memory_store.get_l1_context(connection, user_id, character_id)
    session_memories = (
        memory_store.list_memory(connection, "session", user_id, chat_id=chat_id)
        if chat_id
        else []
    )
    person_memories = (
        memory_store.list_memory(connection, "person", user_id, character_id=character_id)
        if character_id
        else memory_store.list_user_memory(connection, user_id)
    )
    household_memories = memory_store.list_household_memory(connection)
    combined = "\n\n".join(block for block in (session_context, long_term_context) if block.strip())
    promoted_facts = _recent_promoted_facts(connection, user_id, chat_id)
    recent_activity = _recent_memory_activity(connection, user_id, character_id)
    return {
        "ok": True,
        "context": {
            "session": session_context,
            "long_term": long_term_context,
            "combined": combined,
        },
        "recent_promoted_facts": promoted_facts,
        "recent_activity": recent_activity,
        "stats": {
            "session_count": len(session_memories),
            "person_count": len(person_memories),
            "household_count": len(household_memories),
            "session_applied": bool(session_context),
            "long_term_applied": bool(long_term_context),
        },
    }


def _recent_promoted_facts(
    connection: Any,
    user_id: str,
    chat_id: Optional[str],
) -> list[dict[str, Any]]:
    """Return the latest promoted person-memory facts for one owned chat."""
    if not chat_id:
        return []
    try:
        history = chat_store.load_chat_history(connection, user_id, chat_id)
    except ValueError:
        return []
    for message in reversed(history):
        if str(message.get("role") or "") != "assistant":
            continue
        meta = message.get("meta")
        if not isinstance(meta, dict):
            continue
        memory_debug = meta.get("memory_debug")
        if not isinstance(memory_debug, dict):
            continue
        promoted = memory_debug.get("promoted_facts")
        if isinstance(promoted, list):
            return [fact for fact in promoted if isinstance(fact, dict)]
    return []


def _recent_memory_activity(
    connection: Any,
    user_id: str,
    character_id: Optional[str],
) -> list[dict[str, Any]]:
    """Return recent durable-memory activity for the signed-in user."""
    rows = connection.execute(
        """
        SELECT table_name, operation, payload_json, timestamp
        FROM memory_sync_queue
        WHERE table_name IN ('mem_char_user_memory', 'mem_household_context')
        ORDER BY timestamp DESC, id DESC
        LIMIT 50
        """
    ).fetchall()
    activity: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if str(payload.get("scope") or "") == "person" and str(payload.get("user_id") or "") != user_id:
            continue
        if character_id and str(payload.get("scope") or "") == "person":
            if str(payload.get("character_id") or "") != character_id:
                continue
        activity.append(
            {
                "scope": str(payload.get("scope") or ""),
                "operation": str(row["operation"] or ""),
                "key": str(payload.get("key") or ""),
                "value": str(payload.get("value") or ""),
                "source": str(payload.get("source") or ""),
                "character_id": str(payload.get("character_id") or ""),
                "timestamp": str(row["timestamp"] or ""),
            }
        )
        if len(activity) >= 12:
            break
    return activity


@router.post("/sync")
def sync_memory_api(
    payload: MemorySyncRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Pull incremental memory updates since a given watermark."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        delta = memory_store.sync_delta(connection, payload.node_id, payload.watermark)
        return {"ok": True, "delta": delta, "watermark": memory_store.get_latest_watermark(connection)}


@router.get("")
def list_memory_api(
    scope: str = Query(..., min_length=1),
    chat_id: Optional[str] = Query(default=None),
    character_id: Optional[str] = Query(default=None),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return memory rows for one explicit scope."""
    with connection_scope() as connection:
        normalized_scope = scope.strip().lower()
        owned_chat_id = _require_owned_chat(connection, current_user["id"], chat_id) if normalized_scope == "session" else None
        try:
            return _memory_response(
                connection,
                scope=normalized_scope,
                user_id=current_user["id"],
                chat_id=owned_chat_id,
                character_id=character_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/context")
def get_memory_context_api(
    chat_id: Optional[str] = Query(default=None),
    character_id: Optional[str] = Query(default=None),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the exact scoped memory blocks available for prompt injection."""
    with connection_scope() as connection:
        owned_chat_id = _require_owned_chat(connection, current_user["id"], chat_id) if chat_id else None
        return _memory_context_response(
            connection,
            user_id=current_user["id"],
            chat_id=owned_chat_id,
            character_id=character_id,
        )


@router.post("")
def write_memory_api(
    payload: MemoryWriteRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist one scoped memory row."""
    with connection_scope() as connection:
        if payload.scope == "household":
            enforce_admin(current_user)
        chat_id = _require_owned_chat(connection, current_user["id"], payload.chat_id) if payload.scope == "session" else None
        try:
            written = memory_store.write_memory(
                connection,
                scope=payload.scope,
                key=payload.key,
                value=payload.value,
                user_id=current_user["id"],
                chat_id=chat_id,
                character_id=payload.character_id,
                source="api",
                confidence=1.0,
            )
            response = _memory_response(
                connection,
                scope=payload.scope,
                user_id=current_user["id"],
                chat_id=chat_id,
                character_id=payload.character_id,
            )
            response["written"] = written
            return response
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("")
def delete_memory_api(
    scope: str = Query(..., min_length=1),
    key: str = Query(..., min_length=1),
    chat_id: Optional[str] = Query(default=None),
    character_id: Optional[str] = Query(default=None),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one scoped memory row."""
    with connection_scope() as connection:
        normalized_scope = scope.strip().lower()
        if normalized_scope == "household":
            enforce_admin(current_user)
        owned_chat_id = _require_owned_chat(connection, current_user["id"], chat_id) if normalized_scope == "session" else None
        try:
            memory_store.delete_memory(
                connection,
                normalized_scope,
                key,
                current_user["id"],
                chat_id=owned_chat_id,
                character_id=character_id,
            )
            return _memory_response(
                connection,
                scope=normalized_scope,
                user_id=current_user["id"],
                chat_id=owned_chat_id,
                character_id=character_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/user")
def get_user_memory_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return all person-scoped memory for the signed-in user."""
    with connection_scope() as connection:
        return {"ok": True, "memories": memory_store.list_user_memory(connection, current_user["id"])}


@router.delete("/user/{character_id}/{key}")
def delete_user_memory_api(
    character_id: str,
    key: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one person-scoped memory fact for the signed-in user."""
    with connection_scope() as connection:
        memory_store.delete_user_memory(connection, current_user["id"], character_id, key)
        return {"ok": True, "memories": memory_store.list_user_memory(connection, current_user["id"])}


@router.get("/household")
def get_household_memory_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Return all household memory rows for admins."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        return {"ok": True, "memories": memory_store.list_household_memory(connection)}


@router.post("/household")
def post_household_memory_api(
    payload: MemoryAddRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Add one household memory row for admins."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        memory_store.write_memory(
            connection,
            scope="household",
            key=payload.key,
            value=payload.value,
            user_id=current_user["id"],
            source="admin_ui",
            confidence=1.0,
        )
        return {"ok": True, "memories": memory_store.list_household_memory(connection)}


@router.delete("/household/{key}")
def delete_household_memory_api(
    key: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one household memory row for admins."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        memory_store.delete_household_memory(connection, key, user_id=current_user["id"])
        return {"ok": True, "memories": memory_store.list_household_memory(connection)}
