"""Character system HTTP routes (Phase 1).

Two route groups, two permission tiers:

* **Admin** routes mutate the global catalog (`characters` table).
  Guarded by ``require_admin`` — same pattern as the skills admin
  routes. These power the future Character Playground.

* **User** routes let any authenticated user list the resolved
  catalog (with their personal overrides merged in), pick an active
  character, and customize a subset of fields on top of a catalog
  row. They never touch the catalog itself.

The merge direction (catalog ← user_overrides) and the list of
user-overridable fields live in ``character_ops`` so this module
stays a thin HTTP layer.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core import character_access as access
from lokidoki.core import character_ops as ops
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()


# ====================================================================
# Pydantic models
# ====================================================================

class CharacterCreate(BaseModel):
    name: str
    description: str = ""
    phonetic_name: str = ""
    behavior_prompt: str = ""
    avatar_style: str = "bottts"
    avatar_seed: str = ""
    avatar_config: dict[str, Any] = {}
    voice_id: Optional[str] = None
    wakeword_id: Optional[str] = None
    source: str = "admin"


class CharacterPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    phonetic_name: Optional[str] = None
    behavior_prompt: Optional[str] = None
    avatar_style: Optional[str] = None
    avatar_seed: Optional[str] = None
    avatar_config: Optional[dict[str, Any]] = None
    voice_id: Optional[str] = None
    wakeword_id: Optional[str] = None


class UserOverridePatch(BaseModel):
    name: Optional[str] = None
    phonetic_name: Optional[str] = None
    description: Optional[str] = None
    behavior_prompt: Optional[str] = None
    avatar_style: Optional[str] = None
    avatar_seed: Optional[str] = None
    avatar_config: Optional[dict[str, Any]] = None


class SetActiveBody(BaseModel):
    character_id: int


# ====================================================================
# User-facing routes (any authenticated user)
# ====================================================================

@router.get("")
async def list_characters_for_user(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Return *visible* catalog merged with this user's overrides + active id.

    Filters by the global+per-user access tiers — globally-disabled
    or user-denied characters never appear in the picker.
    """
    def _go(conn):
        merged = ops.list_visible_characters_for_user(conn, user.id)
        active_id = ops.get_active_character_id(conn, user.id)
        return {"characters": merged, "active_character_id": active_id}
    return await memory.run_sync(_go)


@router.get("/active")
async def get_active(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    resolved = await memory.run_sync(
        lambda conn: ops.get_active_character_for_user(conn, user.id)
    )
    if resolved is None:
        raise HTTPException(status_code=404, detail="no_characters_available")
    return resolved


@router.post("/active")
async def set_active(
    body: SetActiveBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        if ops.get_character(conn, body.character_id) is None:
            return "missing"
        if not access.is_visible_to_user(conn, user.id, body.character_id):
            return "forbidden"
        ops.set_active_character(conn, user.id, body.character_id)
        return "ok"
    result = await memory.run_sync(_go)
    if result == "missing":
        raise HTTPException(status_code=404, detail="character_not_found")
    if result == "forbidden":
        raise HTTPException(status_code=403, detail="character_not_available")
    return {"ok": True, "active_character_id": body.character_id}


@router.put("/{character_id}/override")
async def set_override(
    character_id: int,
    body: UserOverridePatch,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """UPSERT a user's override fields on top of a catalog character.

    Pass a field as ``null`` to clear that single override (the merge
    will fall back to the catalog value). To clear *all* overrides
    for a character, DELETE the override resource instead.
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="no_fields")

    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return None
        try:
            ops.set_user_override(conn, user.id, character_id, **fields)
        except ValueError as exc:
            return ("err", str(exc))
        return ops.resolve_character_for_user(conn, user.id, character_id)
    result = await memory.run_sync(_go)
    if result is None:
        raise HTTPException(status_code=404, detail="character_not_found")
    if isinstance(result, tuple) and result[0] == "err":
        raise HTTPException(status_code=400, detail=result[1])
    return result


@router.delete("/{character_id}/override")
async def clear_override(
    character_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    await memory.run_sync(
        lambda conn: ops.clear_user_overrides(conn, user.id, character_id)
    )
    return {"ok": True}


# ====================================================================
# Admin catalog routes
# ====================================================================

class GlobalEnableBody(BaseModel):
    enabled: bool


class UserEnableBody(BaseModel):
    # ``enabled=null`` clears the per-user override (inherit-from-global).
    enabled: Optional[bool] = None


@router.get("/admin/catalog")
async def admin_list_catalog(
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Full catalog with global enable state — admin view, unfiltered."""
    def _go(conn):
        rows = ops.list_characters(conn)
        out: list[dict] = []
        for r in rows:
            cid = int(r["id"])
            merged = dict(r)
            try:
                import json as _json
                merged["avatar_config"] = _json.loads(
                    merged.get("avatar_config") or "{}"
                )
            except Exception:
                merged["avatar_config"] = {}
            merged["global_enabled"] = access.get_global_enabled(conn, cid)
            out.append(merged)
        return {"characters": out}
    return await memory.run_sync(_go)


@router.post("/admin/{character_id}/enable")
async def admin_set_global_enabled(
    character_id: int,
    body: GlobalEnableBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return False
        access.set_global_enabled(conn, character_id, body.enabled)
        return True
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="character_not_found")
    return {"ok": True, "character_id": character_id, "enabled": body.enabled}


@router.get("/admin/users/{user_id}/access")
async def admin_user_access_matrix(
    user_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Return per-user access matrix for the admin assignment UI."""
    def _go(conn):
        return {"matrix": access.list_user_access_matrix(conn, user_id)}
    return await memory.run_sync(_go)


@router.post("/admin/users/{user_id}/characters/{character_id}/enable")
async def admin_set_user_enabled(
    user_id: int,
    character_id: int,
    body: UserEnableBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return False
        access.set_user_enabled(conn, user_id, character_id, body.enabled)
        return True
    ok = await memory.run_sync(_go)
    if not ok:
        raise HTTPException(status_code=404, detail="character_not_found")
    return {
        "ok": True,
        "user_id": user_id,
        "character_id": character_id,
        "enabled": body.enabled,
    }


@router.post("/admin")
async def admin_create(
    body: CharacterCreate,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name_required")
    if body.source == "builtin":
        # Builtins are seeded by the app itself. Admins create
        # 'admin'-source rows; allowing 'builtin' here would let an
        # admin produce un-deletable characters by accident.
        raise HTTPException(status_code=400, detail="cannot_create_builtin")

    def _go(conn):
        try:
            cid = ops.create_character(
                conn,
                name=body.name.strip(),
                description=body.description,
                phonetic_name=body.phonetic_name,
                behavior_prompt=body.behavior_prompt,
                avatar_style=body.avatar_style,
                avatar_seed=body.avatar_seed,
                avatar_config=body.avatar_config,
                voice_id=body.voice_id,
                wakeword_id=body.wakeword_id,
                source=body.source,
            )
        except ValueError as exc:
            return ("err", str(exc))
        return cid
    result = await memory.run_sync(_go)
    if isinstance(result, tuple) and result[0] == "err":
        raise HTTPException(status_code=400, detail=result[1])
    return {"id": result}


@router.patch("/admin/{character_id}")
async def admin_patch(
    character_id: int,
    body: CharacterPatch,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Edit a catalog row in place. All sources (builtin/admin/user)
    are edited directly — copy-on-write was removed; the seeder is
    insert-if-missing so builtin edits survive reboots. The escape
    hatch for builtins is ``POST /admin/{id}/reset-to-builtin``.
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="no_fields")

    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return None
        try:
            return ops.edit_character(conn, character_id, **fields)
        except ValueError as exc:
            return ("err", str(exc))
    result = await memory.run_sync(_go)
    if result is None:
        raise HTTPException(status_code=404, detail="character_not_found")
    if isinstance(result, tuple) and result[0] == "err":
        raise HTTPException(status_code=400, detail=result[1])
    return {"id": result}


@router.post("/admin/{character_id}/reset-to-builtin")
async def admin_reset_to_builtin(
    character_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Reapply BUILTIN_SPECS to a builtin character. Escape hatch for
    'I broke Loki, give me the original back'. Per-user overrides
    survive (they FK on id, not name).
    """
    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return ("missing",)
        try:
            ops.reset_builtin_to_spec(conn, character_id)
        except ValueError as exc:
            return ("err", str(exc))
        return ("ok",)
    result = await memory.run_sync(_go)
    if result == ("missing",):
        raise HTTPException(status_code=404, detail="character_not_found")
    if result[0] == "err":
        raise HTTPException(status_code=400, detail=result[1])
    return {"ok": True, "id": character_id}


@router.delete("/admin/{character_id}")
async def admin_delete(
    character_id: int,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        if ops.get_character(conn, character_id) is None:
            return ("missing",)
        try:
            ops.delete_character(conn, character_id)
        except ValueError as exc:
            return ("err", str(exc))
        return ("ok",)
    result = await memory.run_sync(_go)
    if result == ("missing",):
        raise HTTPException(status_code=404, detail="character_not_found")
    if result[0] == "err":
        raise HTTPException(status_code=400, detail=result[1])
    return {"ok": True}
