"""Admin routes — user management. Guarded by require_admin."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from typing import Optional

from lokidoki.auth import users as users_mod
from lokidoki.auth.dependencies import get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core.confidence import effective_confidence
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


class CreateUserRequest(BaseModel):
    username: str
    pin: str
    role: str = "user"


class ResetPinRequest(BaseModel):
    new_pin: str = Field(..., min_length=4, max_length=64)


def _serialize(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "role": u.role,
        "status": u.status,
    }


@router.get("/users")
async def list_users(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    users = await users_mod.list_users(memory)
    return {"users": [_serialize(u) for u in users]}


@router.post("/users")
async def create_user(
    body: CreateUserRequest,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="invalid_role")
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="username_required")
    existing = await users_mod.get_user_by_username(memory, body.username.strip())
    if existing is not None and existing.status != "deleted":
        raise HTTPException(status_code=409, detail="username_taken")
    try:
        u = await users_mod.create_user(
            memory,
            username=body.username.strip(),
            pin=body.pin,
            role=body.role,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _serialize(u)


async def _get_target(memory: MemoryProvider, user_id: int) -> User:
    u = await users_mod.get_user(memory, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    return u


@router.post("/users/{user_id}/disable")
async def disable_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_disable_self")
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "disabled")
    return {"ok": True}


@router.post("/users/{user_id}/enable")
async def enable_user(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "active")
    return {"ok": True}


@router.post("/users/{user_id}/delete")
async def delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_delete_self")
    await _get_target(memory, user_id)
    await users_mod.set_status(memory, user_id, "deleted")
    return {"ok": True}


@router.post("/users/{user_id}/promote")
async def promote_user(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    await users_mod.set_role(memory, user_id, "admin")
    return {"ok": True}


@router.post("/users/{user_id}/demote")
async def demote_user(
    user_id: int,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_demote_self")
    await _get_target(memory, user_id)
    await users_mod.set_role(memory, user_id, "user")
    return {"ok": True}


# --- People / Facts admin -------------------------------------------------


def _decorate_fact(f: dict) -> dict:
    out = dict(f)
    last = out.get("last_observed_at") or out.get("updated_at") or out.get("created_at") or ""
    out["effective_confidence"] = effective_confidence(
        float(out.get("confidence") or 0.0),
        last,
        out.get("category") or "general",
    )
    return out


class AdminCreatePerson(BaseModel):
    name: str


class AdminAddRelationship(BaseModel):
    relation: str


class AdminFactPatch(BaseModel):
    value: Optional[str] = None
    predicate: Optional[str] = None
    subject: Optional[str] = None
    subject_ref_id: Optional[int] = None
    subject_type: Optional[str] = None
    status: Optional[str] = None


@router.get("/users/{user_id}/people")
async def admin_list_people(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    return {"people": await memory.list_people(user_id)}


@router.post("/users/{user_id}/people")
async def admin_create_person(
    user_id: int,
    body: AdminCreatePerson,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name_required")
    pid = await memory.create_person(user_id, body.name.strip())
    return {"id": pid}


@router.patch("/people/{person_id}")
async def admin_rename_person(
    person_id: int,
    body: AdminCreatePerson,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
    target_user_id: int = 0,
):
    # We accept the person_id directly; admin routes are not user-scoped
    # by URL since the admin can edit any user's people. The person row
    # carries owner_user_id which the SQL helpers enforce.
    # We need the owner — look it up.
    ok = False
    async def _go(conn):
        row = conn.execute(
            "SELECT owner_user_id FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if not row:
            return False
        from lokidoki.core import memory_people_sql as psql
        return psql.update_person_name(conn, int(row["owner_user_id"]), person_id, body.name.strip())
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"ok": True}


@router.delete("/people/{person_id}")
async def admin_delete_person(
    person_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    async def _go(conn):
        row = conn.execute(
            "SELECT owner_user_id FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if not row:
            return False
        from lokidoki.core import memory_people_sql as psql
        return psql.delete_person(conn, int(row["owner_user_id"]), person_id)
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"ok": True}


@router.post("/people/{person_id}/relationships")
async def admin_add_relationship(
    person_id: int,
    body: AdminAddRelationship,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    async def _go(conn):
        row = conn.execute(
            "SELECT owner_user_id FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if not row:
            return None
        from lokidoki.core import memory_people_sql as psql
        return psql.upsert_relationship(conn, int(row["owner_user_id"]), person_id, body.relation.strip())
    rel_id = await memory.run_sync(_go)
    if rel_id is None:
        raise HTTPException(status_code=404, detail="person_not_found")
    return {"id": rel_id}


@router.get("/users/{user_id}/facts")
async def admin_list_user_facts(
    user_id: int,
    status: Optional[str] = None,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if status:
        statuses = tuple(s.strip() for s in status.split(",") if s.strip())
    else:
        statuses = ("active", "ambiguous", "pending", "rejected", "superseded")
    rows = await memory.list_facts_by_status(user_id, statuses, limit=500)
    return {"facts": [_decorate_fact(r) for r in rows]}


@router.post("/facts/{fact_id}/promote")
async def admin_promote_fact(
    fact_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    async def _go(conn):
        row = conn.execute(
            "SELECT owner_user_id, confidence FROM facts WHERE id = ?", (fact_id,)
        ).fetchone()
        if not row:
            return False
        new_conf = max(0.85, float(row["confidence"]))
        conn.execute(
            "UPDATE facts SET status = 'active', confidence = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (new_conf, fact_id),
        )
        conn.commit()
        return True
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


@router.post("/facts/{fact_id}/reject")
async def admin_reject_fact(
    fact_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    async def _go(conn):
        cur = conn.execute(
            "UPDATE facts SET status = 'rejected', updated_at = datetime('now') "
            "WHERE id = ?",
            (fact_id,),
        )
        conn.commit()
        return cur.rowcount > 0
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


@router.patch("/facts/{fact_id}")
async def admin_patch_fact(
    fact_id: int,
    body: AdminFactPatch,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="no_fields")
    async def _go(conn):
        row = conn.execute(
            "SELECT owner_user_id FROM facts WHERE id = ?", (fact_id,)
        ).fetchone()
        if not row:
            return False
        from lokidoki.core import memory_sql as sql_mod
        return sql_mod.patch_fact(conn, int(row["owner_user_id"]), fact_id, **fields)
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


@router.delete("/facts/{fact_id}")
async def admin_delete_fact(
    fact_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    async def _go(conn):
        cur = conn.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
        conn.commit()
        return cur.rowcount > 0
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="fact_not_found")
    return {"ok": True}


# --- Database reset -------------------------------------------------------


# Tables wiped by reset_memory. Order matters: child tables first so the
# FK cascades don't fight us, even though most have ON DELETE CASCADE.
_MEMORY_TABLES_TO_WIPE = (
    "facts",
    "ambiguity_groups",
    "person_relationship_edges",
    "person_overlays",
    "person_events",
    "person_media",
    "person_user_links",
    "relationships",
    "people",
    "messages",
    "sessions",
    "user_sentiment",
    "facts_fts",
    "messages_fts",
)

_PEOPLE_TABLES_TO_WIPE = (
    "person_relationship_edges",
    "person_overlays",
    "person_events",
    "person_media",
    "person_user_links",
    "relationships",
    "gedcom_import_jobs",
    "gedcom_export_jobs",
    "ambiguity_groups",
    "people",
)

_APP_TABLES_TO_WIPE = (
    "message_feedback_tags",
    "message_feedback",
    "user_character_overrides",
    "character_enabled_user",
    "character_enabled_global",
    "character_assignments",
    "characters",
    "wakewords",
    "voices",
    "skill_enabled_user",
    "skill_enabled_global",
    "skill_config_user",
    "skill_config_global",
    "skill_result_cache",
    "clarification_state",
    "messages",
    "sessions",
    "facts",
    "ambiguity_groups",
    "sentiment_log",
    "user_sentiment",
    "person_relationship_edges",
    "person_overlays",
    "person_events",
    "person_media",
    "person_user_links",
    "relationships",
    "gedcom_import_jobs",
    "gedcom_export_jobs",
    "people",
    "projects",
    "users",
    "facts_fts",
    "messages_fts",
)


def _delete_tables(conn, tables: tuple[str, ...]) -> dict[str, int]:
    """Best-effort DELETE across a fixed table list."""
    wiped: dict[str, int] = {}
    for table in tables:
        try:
            cur = conn.execute(f"DELETE FROM {table}")
            wiped[table] = cur.rowcount
        except Exception:
            wiped[table] = 0
    return wiped


@router.post("/reset-memory")
async def reset_memory(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Wipe all memory/conversation data. Keeps users and projects.

    Use this from the Admin tab when you want a clean slate to retest
    fact extraction without losing your admin login or project setup.
    """
    def _go(conn):
        wiped = _delete_tables(conn, _MEMORY_TABLES_TO_WIPE)
        # vec_facts is optional (sqlite-vec).
        try:
            conn.execute("DELETE FROM vec_facts")
        except Exception:
            pass
        conn.commit()
        return wiped
    wiped = await memory.run_sync(_go)
    return {"ok": True, "wiped": wiped}


@router.post("/reset-people")
async def reset_people(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Wipe people graph data and person-linked memory, keep chats/users."""
    def _go(conn):
        person_fact_row = conn.execute(
            "SELECT COUNT(*) FROM facts "
            "WHERE subject_type = 'person' OR subject_ref_id IS NOT NULL OR kind = 'relationship'"
        ).fetchone()
        wiped = _delete_tables(conn, _PEOPLE_TABLES_TO_WIPE)
        wiped["facts_person"] = int(person_fact_row[0]) if person_fact_row else 0
        conn.execute(
            "DELETE FROM facts "
            "WHERE subject_type = 'person' OR subject_ref_id IS NOT NULL OR kind = 'relationship'"
        )
        conn.commit()
        return wiped
    wiped = await memory.run_sync(_go)
    return {"ok": True, "wiped": wiped}


@router.post("/reset-everything")
async def reset_everything(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Factory-reset the app state stored in SQLite.

    Deletes users, projects, chats, people, settings/config rows, and
    catalog rows so the next load behaves like first boot again.
    """
    def _go(conn):
        from lokidoki.core.character_seed import run_seed

        wiped = _delete_tables(conn, _APP_TABLES_TO_WIPE)
        try:
            conn.execute("DELETE FROM vec_facts")
        except Exception:
            pass
        try:
            conn.execute("DELETE FROM vec_messages")
        except Exception:
            pass
        conn.commit()
        run_seed(conn)
        return wiped
    wiped = await memory.run_sync(_go)
    return {"ok": True, "wiped": wiped}


@router.get("/knowledge-gaps")
async def list_knowledge_gaps(
    _: User = Depends(require_admin),
):
    """List recent knowledge gaps from the persistent log file."""
    import os
    import json
    log_path = "data/knowledge_gaps.jsonl"
    if not os.path.exists(log_path):
        return {"gaps": []}
        
    gaps = []
    try:
        with open(log_path, "r") as f:
            for line in f:
                if line.strip():
                    gaps.append(json.loads(line))
    except Exception:
        # If the file is huge or corrupted, we just return what we have
        pass
        
    # Return last 100 gaps
    return {"gaps": gaps[-100:]}


@router.post("/users/{user_id}/reset-pin")
async def reset_pin(
    user_id: int,
    body: ResetPinRequest,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    await _get_target(memory, user_id)
    try:
        await users_mod.reset_pin(memory, user_id, body.new_pin)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}
