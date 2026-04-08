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
from lokidoki.core.confidence import effective_confidence
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


def _decorate_fact(f: dict) -> dict:
    """Add ``effective_confidence`` to a fact dict for the wire."""
    out = dict(f)
    last = out.get("last_observed_at") or out.get("updated_at") or out.get("created_at") or ""
    out["effective_confidence"] = effective_confidence(
        float(out.get("confidence") or 0.0),
        last,
        out.get("category") or "general",
    )
    return out


@router.get("/facts")
async def get_facts(
    project_id: Optional[int] = None,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    facts = await memory.list_facts(user.id, limit=200, project_id=project_id)
    return {"facts": [_decorate_fact(f) for f in facts]}


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


@router.get("/messages/{message_id}")
async def get_message(
    message_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Fetch a single message by id, scoped to the current user.

    Used by the Memory tab's source-message viewer: every fact carries
    a ``source_message_id`` pointing at the user turn it was extracted
    from. Clicking the fact loads the verbatim source so you can
    audit and debug bad extractions.
    """
    def _do(conn):
        row = conn.execute(
            "SELECT id, session_id, role, content, created_at "
            "FROM messages WHERE id = ? AND owner_user_id = ?",
            (message_id, user.id),
        ).fetchone()
        return dict(row) if row else None

    message = await memory.run_sync(_do)
    if message is None:
        raise HTTPException(status_code=404, detail="message_not_found")
    return {"message": message}


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
    return {"person": person, "facts": [_decorate_fact(f) for f in facts]}


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


class FactPatch(BaseModel):
    value: Optional[str] = None
    predicate: Optional[str] = None
    subject: Optional[str] = None
    subject_ref_id: Optional[int] = None
    subject_type: Optional[str] = None
    status: Optional[str] = None


@router.post("/facts/{fact_id}/confirm")
async def confirm_fact(
    fact_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    new_conf = await memory.confirm_fact(user.id, fact_id)
    if new_conf is None:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"id": fact_id, "confidence": new_conf}


@router.post("/facts/{fact_id}/reject")
async def reject_fact(
    fact_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.reject_fact(user.id, fact_id)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


@router.patch("/facts/{fact_id}")
async def patch_fact(
    fact_id: int,
    body: FactPatch,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="no_fields")
    ok = await memory.patch_fact(user.id, fact_id, **fields)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


@router.delete("/facts/{fact_id}")
async def delete_fact(
    fact_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.delete_fact(user.id, fact_id)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


class CreatePerson(BaseModel):
    name: str


@router.post("/people")
async def create_person(
    body: CreatePerson,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name_required")
    pid = await memory.create_person(user.id, body.name.strip())
    return {"id": pid, "name": body.name.strip()}


@router.patch("/people/{person_id}")
async def rename_person(
    person_id: int,
    body: CreatePerson,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.update_person_name(user.id, person_id, body.name.strip())
    if not ok:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"ok": True}


@router.delete("/people/{person_id}")
async def delete_person(
    person_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.delete_person(user.id, person_id)
    if not ok:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"ok": True}


class AddRelationship(BaseModel):
    relation: str


@router.post("/people/{person_id}/relationships")
async def add_relationship(
    person_id: int,
    body: AddRelationship,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    if not body.relation.strip():
        raise HTTPException(status_code=400, detail="relation_required")
    rel_id = await memory.add_relationship(user.id, person_id, body.relation.strip())
    return {"id": rel_id}


class SetPrimaryRelationship(BaseModel):
    relation: str  # empty string clears all relationships for the person


@router.put("/people/{person_id}/primary-relationship")
async def set_primary_relationship(
    person_id: int,
    body: SetPrimaryRelationship,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Replace ALL existing relationships for a person with one new edge.

    Used by the Memory UI's relationship dropdown so changing 'brother'
    to 'cousin' actually replaces the value instead of stacking. Pass
    ``relation=""`` to clear every relationship for the person.
    """
    rel_id = await memory.set_primary_relationship(
        user.id, person_id, body.relation,
    )
    return {"id": rel_id}


@router.delete("/relationships/{rel_id}")
async def delete_relationship(
    rel_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.delete_relationship(user.id, rel_id)
    if not ok:
        raise HTTPException(status_code=404, detail="relationship_not_found")
    return {"ok": True}


@router.get("/ambiguity_groups")
async def list_ambiguity_groups(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    import json as _json

    rows = await memory.list_unresolved_ambiguity_groups(user.id)
    return {
        "groups": [
            {
                "id": r["id"],
                "raw_name": r["raw_name"],
                "candidate_person_ids": _json.loads(r["candidate_person_ids"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


class ResolveAmbiguity(BaseModel):
    person_id: int = Field(..., gt=0)


@router.post("/ambiguity_groups/{group_id}/resolve")
async def resolve_ambiguity(
    group_id: int,
    body: ResolveAmbiguity,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    ok = await memory.resolve_ambiguity_group(user.id, group_id, body.person_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not_found")
    return {"ok": True}


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
