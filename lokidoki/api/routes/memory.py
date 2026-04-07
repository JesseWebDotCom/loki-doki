"""Memory HTTP routes.

PR2 introduced ``current_user`` scoping. PR3 adds the people /
relationships / conflicts surface plus the merge endpoint that powers
the Memory page's deduplication UI. The PR2 routes are unchanged.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional, Union

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


@router.get("/facts")
async def get_facts(
    project_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    facts = await memory.list_facts(user.id, limit=200, project_id=project_id)
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
    project_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    sessions = await memory.list_sessions(user.id, project_id=project_id)
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


# --- PR3: people / relationships / conflicts ---------------------------


class MergeRequest(BaseModel):
    into_id: int = Field(..., gt=0)


@router.get("/people")
async def list_people(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    return {"people": await memory.list_people(user.id)}


@router.get("/people/{person_id}")
async def get_person_detail(
    person_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    person = await memory.get_person(user.id, person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="person_not_found")
    facts = await memory.list_facts_about_person(user.id, person_id)
    return {"person": person, "facts": facts}


@router.post("/people/{person_id}/merge")
async def merge_person(
    person_id: int,
    body: MergeRequest,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Fold ``person_id`` into ``into_id``. Owner-only.

    The owner check is implicit: ``merge_people`` scopes both ids by
    ``user_id``, so a foreign person id silently no-ops and we surface
    a 404 instead of leaking that it exists for someone else.
    """
    if person_id == body.into_id:
        raise HTTPException(status_code=400, detail="cannot_merge_into_self")
    ok = await memory.merge_people(user.id, person_id, body.into_id)
    if not ok:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"merged": True, "source_id": person_id, "into_id": body.into_id}


@router.get("/relationships")
async def list_relationships(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    return {"relationships": await memory.list_relationships(user.id)}


@router.get("/facts/conflicts")
async def list_fact_conflicts(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Facts where the same (subject, predicate) has multiple values.

    Returned grouped by ``(subject, predicate)`` so the frontend can
    render each conflict as a single resolvable card.
    """
    rows = await memory.list_fact_conflicts(user.id)
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        key = (row["subject"], row["predicate"])
        groups.setdefault(key, []).append(row)
    return {
        "conflicts": [
            {
                "subject": subject,
                "predicate": predicate,
                "candidates": candidates,
            }
            for (subject, predicate), candidates in groups.items()
        ]
    }


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
