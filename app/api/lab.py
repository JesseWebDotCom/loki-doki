"""Prompt Lab and development API routes."""

from __future__ import annotations

import time
from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user, enforce_admin
from app.models.admin import AdminPromptLabRequest, AdminPromptLabCompileRequest
from app.subsystems.character import character_service
from app.runtime import runtime_context
from app.classifier import Classification
from app.orchestrator import route_message
from app.subsystems.text import generate_text_reply
from app.skills import skill_service, SkillExecutionError
from app.skills.rendering import skill_render_context, skill_should_skip_character_render
from app.api.utils import sanitize_user, execution_meta

router = APIRouter(prefix="/admin/prompt-lab", tags=["admin"])


def _clean_prompt_lab_overrides(layer_overrides: dict[str, str]) -> dict[str, str]:
    """Return only prompt-lab layer overrides that actually contain draft text."""
    return {
        key: str(value)
        for key, value in layer_overrides.items()
        if key in {
            "core_safety_prompt",
            "account_policy_prompt",
            "admin_prompt",
            "care_profile_prompt",
            "user_prompt",
            "character_custom_prompt",
            "character_prompt",
        }
        and str(value).strip()
    }


@router.post("")
async def admin_prompt_lab_api(
    payload: AdminPromptLabRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Run one prompt-lab request as another user and return debug metadata."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        target_user = db.get_user_by_id(connection, payload.user_id)
        if target_user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        target_user = {**target_user, "is_admin": db.get_user_admin_flag(connection, target_user["id"])}
        layer_overrides = _clean_prompt_lab_overrides(payload.layer_overrides)
        target_settings = character_service.get_user_settings(connection, target_user["id"])
        prompt_state = character_service.resolve_prompt_state(
            connection,
            target_user,
            enabled_layers=payload.enabled_layers,
            layer_overrides=layer_overrides,
        )
        compiler_messages = character_service.prompt_compiler_messages(prompt_state["non_empty_layers"])
        started = time.perf_counter()
        context_started = time.perf_counter()
        rendering_context = character_service.build_rendering_context(
            connection,
            target_user,
            context["settings"]["profile"],
            enabled_layers=payload.enabled_layers,
            layer_overrides=layer_overrides,
            compiler_provider=context["providers"]["llm_thinking"],
            persist_compiled=False,
            force_recompile=bool(layer_overrides),
        )
        context_build_ms = round((time.perf_counter() - context_started) * 1000, 2)
        skill_route_ms = 0.0
        skill_execute_ms = 0.0
        render_ms = 0.0
        skill_route = {
            "outcome": "skipped" if not payload.use_skills else "no_skill",
            "reason": "Skill execution disabled in prompt lab." if not payload.use_skills else "No skill routing performed yet.",
            "candidate": None,
            "alternatives": [],
        }
        if payload.use_skills:
            skill_route_started = time.perf_counter()
            skill_route = skill_service.inspect_route(
                connection,
                APP_CONFIG,
                target_user,
                context["settings"]["profile"],
                payload.message,
            )
            skill_route_ms = round((time.perf_counter() - skill_route_started) * 1000, 2)
        try:
            skill_message = None
            if payload.use_skills:
                skill_execute_started = time.perf_counter()
                skill_message = await skill_service.route_and_execute(
                    connection,
                    APP_CONFIG,
                    target_user,
                    context["settings"]["profile"],
                    payload.message,
                )
                skill_execute_ms = round((time.perf_counter() - skill_execute_started) * 1000, 2)
            if skill_message is not None:
                skill_result, skill_context = skill_render_context(skill_message["message"], skill_message.get("route"))
                if skill_should_skip_character_render(skill_message["message"]):
                    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                    skill_meta = dict(skill_message["message"].get("meta", {}))
                    return {
                        "user": sanitize_user(target_user),
                        "profile": context["settings"]["profile"],
                        "elapsed_ms": elapsed_ms,
                        "timings": {
                            "context_build_ms": context_build_ms,
                            "skill_route_ms": skill_route_ms,
                            "skill_execute_ms": skill_execute_ms,
                            "render_ms": 0.0,
                            "total_ms": elapsed_ms,
                        },
                        "route": {
                            "request_type": str(skill_meta.get("request_type") or "skill_call"),
                            "route": str(skill_meta.get("route") or ""),
                            "reason": str(skill_meta.get("reason") or ""),
                        },
                        "skill_route": skill_route,
                        "skill_execution": {
                            "route": skill_message.get("route"),
                            "message": skill_message.get("message"),
                            "result": skill_result,
                        },
                        "response": {
                            "text": str(skill_message["message"].get("content") or ""),
                            "summary": str(skill_message["message"].get("content") or "")[:140],
                            "metadata": {},
                        },
                        "execution": dict(skill_meta.get("execution") or {}),
                        "character": {
                            "id": rendering_context.active_character_id,
                            "enabled": rendering_context.character_enabled,
                        },
                        "care_profile": {
                            "id": target_settings["care_profile_id"],
                            "label": target_settings["care_profile_label"],
                        },
                        "layers": prompt_state["prompt_layers"],
                        "compiler_messages": compiler_messages,
                        "compiled_prompt": rendering_context.base_prompt,
                        "prompt_debug": {
                            **(rendering_context.debug or {}),
                            "llm_used": False,
                        },
                    }
                render_classification = Classification(
                    "skill_call",
                    "character_render",
                    "Skill result rendered through character orchestration.",
                )
                render_started = time.perf_counter()
                rendered = generate_text_reply(
                    payload.message,
                    target_user["display_name"],
                    context["settings"]["profile"],
                    [],
                    context["providers"],
                    render_classification,
                    rendering_context=rendering_context,
                    dynamic_context=skill_context,
                    include_prompt_debug=True,
                )
                render_ms = round((time.perf_counter() - render_started) * 1000, 2)
                elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                return {
                    "user": sanitize_user(target_user),
                    "profile": context["settings"]["profile"],
                    "elapsed_ms": elapsed_ms,
                    "timings": {
                        "context_build_ms": context_build_ms,
                        "skill_route_ms": skill_route_ms,
                        "skill_execute_ms": skill_execute_ms,
                        "render_ms": render_ms,
                        "total_ms": round((time.perf_counter() - started) * 1000, 2),
                    },
                    "route": {
                        "request_type": render_classification.request_type,
                        "route": render_classification.route,
                        "reason": render_classification.reason,
                    },
                    "skill_route": skill_route,
                    "skill_execution": {
                        "route": skill_message.get("route"),
                        "message": skill_message.get("message"),
                        "result": skill_result,
                    },
                    "response": {
                        "text": rendered.reply,
                        "summary": rendered.parsed.summary if rendered.parsed is not None else rendered.reply[:140],
                        "metadata": {} if rendered.parsed is None else rendered.parsed.metadata,
                    },
                    "execution": execution_meta(rendered.provider),
                    "character": {
                        "id": rendering_context.active_character_id,
                        "enabled": rendering_context.character_enabled,
                    },
                    "care_profile": {
                        "id": target_settings["care_profile_id"],
                        "label": target_settings["care_profile_label"],
                    },
                    "layers": prompt_state["prompt_layers"],
                    "compiler_messages": compiler_messages,
                    "compiled_prompt": rendering_context.base_prompt,
                    "prompt_debug": rendered.debug or {},
                }
            render_started = time.perf_counter()
            result = route_message(
                payload.message,
                target_user["display_name"],
                context["settings"]["profile"],
                [],
                context["providers"],
                rendering_context=rendering_context,
                include_prompt_debug=True,
            )
            render_ms = round((time.perf_counter() - render_started) * 1000, 2)
        except (SkillExecutionError, Exception) as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "user": sanitize_user(target_user),
            "profile": context["settings"]["profile"],
            "elapsed_ms": elapsed_ms,
            "timings": {
                "context_build_ms": context_build_ms,
                "skill_route_ms": skill_route_ms,
                "skill_execute_ms": skill_execute_ms,
                "render_ms": render_ms,
                "total_ms": elapsed_ms,
            },
            "route": {
                "request_type": result.classification.request_type,
                "route": result.classification.route,
                "reason": result.classification.reason,
            },
            "skill_route": skill_route,
            "skill_execution": None,
            "response": {
                "text": result.reply,
                "summary": result.parsed.summary if result.parsed is not None else result.reply[:140],
                "metadata": {} if result.parsed is None else result.parsed.metadata,
            },
            "execution": execution_meta(result.provider),
            "character": {
                "id": rendering_context.active_character_id,
                "enabled": rendering_context.character_enabled,
            },
            "care_profile": {
                "id": target_settings["care_profile_id"],
                "label": target_settings["care_profile_label"],
            },
            "layers": prompt_state["prompt_layers"],
            "compiler_messages": compiler_messages,
            "compiled_prompt": rendering_context.base_prompt,
            "prompt_debug": result.debug or {},
        }


@router.post("/compile")
async def admin_prompt_lab_compile_api(
    payload: AdminPromptLabCompileRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Compile one temporary prompt-lab layer stack without saving it."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        target_user = db.get_user_by_id(connection, payload.user_id)
        if target_user is None:
            raise HTTPException(status_code=404, detail="User not found.")
        target_user = {**target_user, "is_admin": db.get_user_admin_flag(connection, target_user["id"])}
        layer_overrides = _clean_prompt_lab_overrides(payload.layer_overrides)
        prompt_state = character_service.resolve_prompt_state(
            connection,
            target_user,
            enabled_layers=payload.enabled_layers,
            layer_overrides=layer_overrides,
        )
        compiler_messages = character_service.prompt_compiler_messages(prompt_state["non_empty_layers"])
        started = time.perf_counter()
        
        # We use rendering-context compilation as the prompt-lab compile proxy.
        rendering_context = character_service.build_rendering_context(
            connection,
            target_user,
            context["settings"]["profile"],
            enabled_layers=payload.enabled_layers,
            layer_overrides=layer_overrides,
            compiler_provider=context["providers"]["llm_thinking"],
            persist_compiled=False,
            force_recompile=True
        )
        compile_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "user": sanitize_user(target_user),
            "profile": context["settings"]["profile"],
            "timing_ms": compile_ms,
            "compiled_prompt": rendering_context.base_prompt,
            "layers": prompt_state["prompt_layers"],
            "enabled_layers": {
                key: prompt_state["enabled_layers"].get(key, True)
                for key in prompt_state["prompt_layers"]
            },
            "compiler_messages": compiler_messages,
            "character": {
                "id": prompt_state["active_character_id"],
                "enabled": prompt_state["character_enabled"],
            },
            "care_profile": {
                "id": prompt_state.get("care_profile", {}).get("id"),
                "label": prompt_state.get("care_profile", {}).get("label"),
            },
        }
