"""Skill configuration routes — registry backed.

Two tiers of config per capability, mirroring the storage layer:

  * **Global** (admin only): values that apply to every user, e.g.
    a server-paid TMDB API key.
  * **User** (any authenticated user): personal overrides or
    additions, e.g. a default zip code, a user's own API key.

Both are validated against the capability config manifest at write
time so callers can't store fields the capability doesn't declare.
Secret-typed fields are masked on read.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core import skill_config as cfg
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.orchestrator.core.types import (
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)
from lokidoki.orchestrator.execution.executor import execute_chunk_async
from lokidoki.orchestrator.registry.runtime import get_runtime

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Config manifest (separate from the function registry)
# ---------------------------------------------------------------------------

def _load_config_schemas() -> dict[str, dict]:
    """Load capability config schemas from capability_config.json."""
    path = (
        Path(__file__).resolve().parents[2]
        / "orchestrator"
        / "data"
        / "capability_config.json"
    )
    if not path.exists():
        return {}
    return json.loads(path.read_text())


_CONFIG_SCHEMAS: dict[str, dict] = _load_config_schemas()


def _get_schema(capability: str) -> dict:
    return _CONFIG_SCHEMAS.get(capability, {"global": [], "user": []})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_HUMANIZE_RE = re.compile(r"^(get|set|list|lookup|search|create|delete|read|check|find|cancel|log|control|play|send|make|order|append|update|detect|recall|weigh)_?")


def _humanize(capability: str) -> str:
    """Convert a capability name to a human-friendly display name.

    ``get_weather`` → ``Weather``, ``lookup_movie`` → ``Movie``,
    ``substitute_ingredient`` → ``Substitute Ingredient``.
    """
    name = _HUMANIZE_RE.sub("", capability)
    if not name:
        name = capability
    return name.replace("_", " ").strip().title()


def _capability_or_404(capability: str) -> dict:
    runtime = get_runtime()
    entry = runtime.capabilities.get(capability)
    if not entry:
        raise HTTPException(status_code=404, detail="capability_not_found")
    return entry


# ---------------------------------------------------------------------------
# Per-capability view builder
# ---------------------------------------------------------------------------

class SetValueBody(BaseModel):
    key: str
    value: Any = None


class ToggleBody(BaseModel):
    enabled: bool


class TestBody(BaseModel):
    prompt: str


def _build_capability_view(
    capability: str,
    entry: dict,
    global_vals: dict,
    user_vals: dict,
    global_toggle: bool,
    user_toggle: bool,
) -> dict:
    """Assemble the per-capability payload the frontend expects.

    Maps registry entries to the existing ``SkillSummary`` shape so
    the frontend components need zero changes.
    """
    schema = _get_schema(capability)
    merged = {**global_vals, **user_vals}
    state = cfg.compute_skill_state(
        merged_config=merged,
        schema=schema,
        global_toggle=global_toggle,
        user_toggle=user_toggle,
    )
    return {
        "skill_id": capability,
        "name": _humanize(capability),
        "description": entry.get("description", ""),
        "intents": [capability],
        "examples": entry.get("examples", []),
        "config_schema": schema,
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


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_skills(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """List all capabilities with config, effective values, and state."""
    runtime = get_runtime()
    out: list[dict] = []
    for capability, entry in runtime.capabilities.items():
        def _load(c, cap=capability):
            return (
                cfg.get_global_config(c, cap),
                cfg.get_user_config(c, user.id, cap),
                cfg.get_global_toggle(c, cap),
                cfg.get_user_toggle(c, user.id, cap),
            )

        global_vals, user_vals, g_tog, u_tog = await memory.run_sync(_load)
        out.append(
            _build_capability_view(
                capability, entry, global_vals, user_vals, g_tog, u_tog,
            )
        )
    return {"skills": out}


@router.get("/{skill_id}")
async def get_one(
    skill_id: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    entry = _capability_or_404(skill_id)

    def _load(c):
        return (
            cfg.get_global_config(c, skill_id),
            cfg.get_user_config(c, user.id, skill_id),
            cfg.get_global_toggle(c, skill_id),
            cfg.get_user_toggle(c, user.id, skill_id),
        )

    global_vals, user_vals, g_tog, u_tog = await memory.run_sync(_load)
    return _build_capability_view(
        skill_id, entry, global_vals, user_vals, g_tog, u_tog,
    )


# ---- global tier (admin) ------------------------------------------------

@router.put("/{skill_id}/config/global")
async def set_global(
    skill_id: str,
    body: SetValueBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    _capability_or_404(skill_id)
    schema = _get_schema(skill_id)
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
    _capability_or_404(skill_id)
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
    _capability_or_404(skill_id)
    schema = _get_schema(skill_id)
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
    _capability_or_404(skill_id)
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
    _capability_or_404(skill_id)
    await memory.run_sync(
        lambda c: cfg.set_user_toggle(c, user.id, skill_id, body.enabled)
    )
    return {"ok": True, "enabled": body.enabled}


# ---- test panel (admin) ------------------------------------------------

@router.post("/{skill_id}/test")
async def test_skill(
    skill_id: str,
    body: TestBody,
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Force a prompt through one specific capability via the pipeline."""
    _capability_or_404(skill_id)
    runtime = get_runtime()
    implementation = runtime.select_handler(0, skill_id)
    chunk = RequestChunk(text=body.prompt, index=0)
    route = RouteMatch(
        chunk_index=0,
        capability=skill_id,
        confidence=1.0,
        matched_text=skill_id,
    )
    resolution = ResolutionResult(
        chunk_index=0,
        resolved_target=body.prompt,
        source="admin_test",
        confidence=1.0,
        params={},
    )
    started = time.perf_counter()
    execution = await execute_chunk_async(
        chunk, route, implementation, resolution,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    return {
        "capability": skill_id,
        "handler_name": implementation.handler_name,
        "success": execution.success,
        "output_text": execution.output_text,
        "error": execution.error,
        "timing_ms": round(elapsed_ms, 3),
    }


@router.delete("/{skill_id}/config/user/{key}")
async def delete_user(
    skill_id: str,
    key: str,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    _capability_or_404(skill_id)
    deleted = await memory.run_sync(
        lambda c: cfg.delete_user_value(c, user.id, skill_id, key)
    )
    return {"ok": True, "deleted": deleted}
