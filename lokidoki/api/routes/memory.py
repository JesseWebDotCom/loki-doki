"""Memory HTTP routes — PR2: per-user scoped via current_user dep."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


@router.get("/facts")
async def get_facts(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    facts = await memory.list_facts(user.id, limit=200)
    return {"facts": facts}


@router.get("/facts/search")
async def search_facts(
    q: str = Query(..., min_length=1),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    results = await memory.search_facts(user_id=user.id, query=q, top_k=10)
    return {
        "query": q,
        "results": [
            {"fact": r["value"], "score": r["score"], "subject": r["subject"]}
            for r in results
        ],
    }


@router.get("/sessions")
async def list_sessions(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    sessions = await memory.list_sessions(user.id)
    return {"sessions": [s["id"] for s in sessions], "details": sessions}


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int,
    limit: int = Query(50, ge=1, le=500),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    messages = await memory.get_messages(
        user_id=user.id, session_id=session_id, limit=limit
    )
    return {"session_id": session_id, "messages": messages}


@router.get("/context")
async def get_restoration_context(
    q: str = Query("", min_length=0),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    rolling = await memory.list_facts(user.id, limit=5)
    relevant = (
        await memory.search_facts(user_id=user.id, query=q, top_k=5) if q else []
    )
    return {
        "rolling_context": rolling,
        "relevant_facts": [
            {"fact": r["value"], "score": r["score"]} for r in relevant
        ],
    }
