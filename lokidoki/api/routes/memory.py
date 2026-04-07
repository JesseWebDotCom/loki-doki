"""Memory HTTP routes — PR1 surface.

Routes that depend on PR2 features (cross-chat restoration, sentiment
per session, conflict resolution UI) are deliberately not in this file.
PR1 ships only the read-side endpoints needed by the existing frontend
plus the bare minimum for the new test suite.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from lokidoki.api.routes.chat import get_memory_provider

router = APIRouter()


@router.get("/facts")
async def get_facts():
    """Return the default user's stored facts."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()  # TODO(auth-PR2): real user
    facts = await memory.list_facts(user_id, limit=200)
    return {"facts": facts}


@router.get("/facts/search")
async def search_facts(q: str = Query(..., min_length=1)):
    """FTS5/BM25 fact search scoped to the default user."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()
    results = await memory.search_facts(user_id=user_id, query=q, top_k=10)
    return {
        "query": q,
        "results": [
            {"fact": r["value"], "score": r["score"], "subject": r["subject"]}
            for r in results
        ],
    }


@router.get("/sessions")
async def list_sessions():
    """List sessions for the default user."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()
    sessions = await memory.list_sessions(user_id)
    return {"sessions": [s["id"] for s in sessions], "details": sessions}


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int, limit: int = Query(50, ge=1, le=500)
):
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()
    messages = await memory.get_messages(
        user_id=user_id, session_id=session_id, limit=limit
    )
    return {"session_id": session_id, "messages": messages}


@router.get("/context")
async def get_restoration_context(q: str = Query("", min_length=0)):
    """Cross-chat context restoration: rolling recent facts + FTS matches."""
    memory = await get_memory_provider()
    user_id = await memory.default_user_id()
    rolling = await memory.list_facts(user_id, limit=5)
    relevant = (
        await memory.search_facts(user_id=user_id, query=q, top_k=5)
        if q
        else []
    )
    return {
        "rolling_context": rolling,
        "relevant_facts": [
            {"fact": r["value"], "score": r["score"]} for r in relevant
        ],
    }
