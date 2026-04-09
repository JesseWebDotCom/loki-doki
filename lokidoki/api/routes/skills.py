"""Skill configuration routes.

Two tiers of config per skill, mirroring the storage layer:

  * **Global** (admin only): values that apply to every user, e.g.
    a server-paid OpenWeatherMap API key.
  * **User** (any authenticated user): personal overrides or
    additions, e.g. a default zip code, a user's own API key.

Both are validated against the skill manifest's ``config_schema``
block at write time so callers can't store fields the skill doesn't
declare. Secret-typed fields are masked on read.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import skill_config as cfg
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor
from lokidoki.core.skill_factory import get_skill_instance

router = APIRouter()

# Single registry shared across requests. Scanning is cheap (one
# directory walk + JSON parse per skill) but doing it on every
# request would still add latency for no reason.
_registry = SkillRegistry(skills_dir="lokidoki/skills")
_registry.scan()


def _manifest_or_404(skill_id: str) -> dict:
    m = _registry.skills.get(skill_id)
    if not m:
        raise HTTPException(status_code=404, detail="skill_not_found")
    return m


def _public_manifest(manifest: dict) -> dict:
    """Strip the manifest down to the fields the frontend needs."""
    return {
        "skill_id": manifest.get("skill_id"),
        "name": manifest.get("name"),
        "description": manifest.get("description", ""),
        "intents": manifest.get("intents", []),
        "examples": manifest.get("examples", []),
        "config_schema": manifest.get("config_schema") or {"global": [], "user": []},
    }


class SetValueBody(BaseModel):
    key: str
    value: Any = None


class ToggleBody(BaseModel):
    enabled: bool


class TestBody(BaseModel):
    prompt: str


_executor = SkillExecutor()


# ---- list ---------------------------------------------------------------


def _build_skill_view(
    manifest: dict,
    global_vals: dict,
    user_vals: dict,
    global_toggle: bool,
    user_toggle: bool,
) -> dict:
    """Assemble the per-skill payload returned by both list and detail.

    Computes ``enabled`` and ``disabled_reason`` from the same combined
    state the orchestrator uses, so the UI is the source of truth and
    cannot drift. The ``toggle`` block carries the raw admin/user
    switches for the UI to render distinct on/off controls.
    """
    schema = manifest.get("config_schema") or {"global": [], "user": []}
    merged = {**global_vals, **user_vals}
    state = cfg.compute_skill_state(
        merged_config=merged,
        schema=schema,
        global_toggle=global_toggle,
        user_toggle=user_toggle,
    )
    return {
        **_public_manifest(manifest),
        "global": cfg.mask_secrets(global_vals, schema, "global"),
        "user": cfg.mask_secrets(user_vals, schema, "user"),
        "enabled": state["enabled"],
        "config_ok": state["config_ok"],
        "missing_required": state["missing_required"],
        "disabled_reason": state["disabled_reason"],
        "toggle": {
            "global": global_toggle,
            "user": user_toggle,
        },
    }


@router.get("")
async def list_skills(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """List all skills with their config schema, effective values, and
    enabled state.

    A skill is ``enabled`` only when every ``required: true`` field
    in its ``config_schema`` has a non-empty value in the merged
    global+user config. Disabled skills will be skipped by the
    routing layer at chat time, so this state is the source of truth
    the UI surfaces to the operator.
    """
    out: list[dict] = []
    for skill_id, manifest in _registry.skills.items():

        def _load(c, sid=skill_id):
            return (
                cfg.get_global_config(c, sid),
                cfg.get_user_config(c, user.id, sid),
                cfg.get_global_toggle(c, sid),
                cfg.get_user_toggle(c, user.id, sid),
            )

        global_vals, user_vals, g_tog, u_tog = await memory.run_sync(_load)
        out.append(
            _build_skill_view(manifest, global_vals, user_vals, g_tog, u_tog)
        )
    return {"skills": out}


@router.get("/{skill_id}")
async def get_one(
    skill_id: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    manifest = _manifest_or_404(skill_id)

    def _load(c):
        return (
            cfg.get_global_config(c, skill_id),
            cfg.get_user_config(c, user.id, skill_id),
            cfg.get_global_toggle(c, skill_id),
            cfg.get_user_toggle(c, user.id, skill_id),
        )

    global_vals, user_vals, g_tog, u_tog = await memory.run_sync(_load)
    return _build_skill_view(manifest, global_vals, user_vals, g_tog, u_tog)


# ---- global tier (admin) ------------------------------------------------


@router.put("/{skill_id}/config/global")
async def set_global(
    skill_id: str,
    body: SetValueBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    manifest = _manifest_or_404(skill_id)
    schema = manifest.get("config_schema") or {}
    field = cfg.find_field(schema, "global", body.key)
    if not field:
        raise HTTPException(status_code=400, detail="unknown_field")
    try:
        coerced = cfg.coerce_value(body.value, field.get("type", "string"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await memory.run_sync(
        lambda c: cfg.set_global_value(c, skill_id, body.key, coerced)
    )
    return {"ok": True}


@router.delete("/{skill_id}/config/global/{key}")
async def delete_global(
    skill_id: str,
    key: str,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    _manifest_or_404(skill_id)
    deleted = await memory.run_sync(
        lambda c: cfg.delete_global_value(c, skill_id, key)
    )
    return {"ok": True, "deleted": deleted}


# ---- user tier ----------------------------------------------------------


@router.put("/{skill_id}/config/user")
async def set_user(
    skill_id: str,
    body: SetValueBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    manifest = _manifest_or_404(skill_id)
    schema = manifest.get("config_schema") or {}
    field = cfg.find_field(schema, "user", body.key)
    if not field:
        raise HTTPException(status_code=400, detail="unknown_field")
    try:
        coerced = cfg.coerce_value(body.value, field.get("type", "string"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await memory.run_sync(
        lambda c: cfg.set_user_value(c, user.id, skill_id, body.key, coerced)
    )
    return {"ok": True}


# ---- enable/disable toggles --------------------------------------------


@router.put("/{skill_id}/toggle/global")
async def toggle_global(
    skill_id: str,
    body: ToggleBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Admin manual switch. Off here = off for every user."""
    _manifest_or_404(skill_id)
    await memory.run_sync(
        lambda c: cfg.set_global_toggle(c, skill_id, body.enabled)
    )
    return {"ok": True, "enabled": body.enabled}


@router.put("/{skill_id}/toggle/user")
async def toggle_user(
    skill_id: str,
    body: ToggleBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Per-user manual switch. Independent of the admin toggle."""
    _manifest_or_404(skill_id)
    await memory.run_sync(
        lambda c: cfg.set_user_toggle(c, user.id, skill_id, body.enabled)
    )
    return {"ok": True, "enabled": body.enabled}


@router.post("/{skill_id}/test")
async def test_skill(
    skill_id: str,
    body: TestBody,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Force a prompt through one specific skill, bypassing the
    decomposer/orchestrator routing layer. Admin-only because some
    skills hit paid APIs and we don't want unprivileged users to be
    able to burn server-side credentials at will.

    The skill is invoked exactly the way ``execute_capability_lookup``
    does it: ``query`` is the test prompt, merged global+admin config
    is attached as ``_config``, and every mechanism is tried in
    priority order.
    """
    manifest = _manifest_or_404(skill_id)
    instance = get_skill_instance(skill_id)
    if not instance:
        raise HTTPException(status_code=400, detail="skill_not_instantiable")

    def _load(c):
        return (
            cfg.get_global_config(c, skill_id),
            cfg.get_user_config(c, admin.id, skill_id),
        )

    global_vals, user_vals = await memory.run_sync(_load)
    merged = {**global_vals, **user_vals}

    mechs = _registry.get_mechanisms(skill_id)
    params: dict[str, Any] = {"query": body.prompt, "_config": merged}
    result = await _executor.execute_skill(instance, mechs, params)
    return {
        "success": result.success,
        "data": result.data,
        "mechanism_used": result.mechanism_used,
        "mechanism_log": result.mechanism_log,
        "source_url": result.source_url,
        "source_title": result.source_title,
        "latency_ms": result.latency_ms,
    }


@router.delete("/{skill_id}/config/user/{key}")
async def delete_user(
    skill_id: str,
    key: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    _manifest_or_404(skill_id)
    deleted = await memory.run_sync(
        lambda c: cfg.delete_user_value(c, user.id, skill_id, key)
    )
    return {"ok": True, "deleted": deleted}
