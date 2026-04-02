"""Internal chat-related orchestration helpers."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from uuid import uuid4
from typing import Any, Optional, Union
from fastapi import HTTPException

from app.chats import store as chat_store
from app.classifier import Classification
from app.deps import APP_CONFIG
from app.orchestrator import route_message
from app.subsystems.character import character_service
from app.subsystems.memory import store as memory_store
from app.subsystems.text import reformulate_followup_query
from app.api.utils import execution_meta
from app.skills import SkillExecutionError, skill_service, SkillInstallError
from app.skills.rendering import skill_render_context, skill_should_skip_character_render


def build_memory_context(
    connection: sqlite3.Connection,
    user_id: str,
    *,
    character_id: Optional[str] = None,
    chat_id: Optional[str] = None,
) -> str:
    """Return the combined session and long-term memory context for one chat."""
    blocks: list[str] = []
    if chat_id:
        session_context = memory_store.get_session_context(connection, chat_id)
        if session_context:
            blocks.append(session_context)
    l1_context = memory_store.get_l1_context(connection, user_id, character_id)
    if l1_context:
        blocks.append(l1_context)
    return "\n\n".join(blocks)


def memory_debug_payload(
    connection: sqlite3.Connection,
    user_id: str,
    *,
    character_id: Optional[str] = None,
    chat_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return compact metadata describing how memory was applied."""
    session_context = memory_store.get_session_context(connection, chat_id) if chat_id else ""
    long_term_context = memory_store.get_l1_context(connection, user_id, character_id)
    return {
        "used": bool(session_context or long_term_context),
        "session_applied": bool(session_context),
        "long_term_applied": bool(long_term_context),
        "session_preview": _context_preview(session_context),
        "long_term_preview": _context_preview(long_term_context),
    }


def assistant_message_meta(
    classification: Classification,
    provider: Any,
    result: Optional[Any] = None,
    *,
    turn_id: str = "",
    voice_summary: str = "",
    response_style: str = "",
    response_style_debug: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Return one assistant message metadata payload."""
    meta = {
        "request_type": classification.request_type,
        "route": classification.route,
        "reason": classification.reason,
        "execution": execution_meta(provider),
        "turn_id": turn_id,
    }
    chosen_voice_summary = voice_summary.strip()
    if result is not None and getattr(result, "parsed", None) is not None:
        meta["rendered_response"] = {
            "summary": result.parsed.summary,
            "metadata": result.parsed.metadata,
        }
        if not chosen_voice_summary:
            chosen_voice_summary = str(result.parsed.summary or "").strip()
    if result is not None and getattr(result, "debug", None):
        meta["prompt_debug"] = result.debug
    if not chosen_voice_summary and result is not None:
        chosen_voice_summary = str(getattr(result, "reply", "") or "").strip()
    if chosen_voice_summary:
        meta["voice_summary"] = chosen_voice_summary
    if response_style.strip():
        meta["response_style"] = response_style.strip()
    if response_style_debug:
        meta["response_style_debug"] = response_style_debug
    return meta


def chat_providers(providers: dict[str, Any], *, force_smart: bool = False) -> dict[str, Any]:
    """Return the provider map for one chat turn."""
    if not force_smart:
        return providers
    next_providers = dict(providers)
    next_providers["llm_fast"] = providers["llm_thinking"]
    return next_providers


def resolve_response_style(
    classification: Classification,
    rendering_context: Optional[Any],
    requested_style: Optional[str] = None,
) -> str:
    """Return the effective response style for one turn."""
    return resolve_response_style_policy(
        message="",
        history=[],
        classification=classification,
        rendering_context=rendering_context,
        requested_style=requested_style,
    )["style"]


def resolve_response_style_policy(
    message: str,
    history: list[dict[str, str]],
    classification: Classification,
    rendering_context: Optional[Any],
    requested_style: Optional[str] = None,
    *,
    turn_id: str = "",
) -> dict[str, Any]:
    """Return the weighted response-style decision and debug factors for one turn."""
    normalized = str(requested_style or "").strip()
    if normalized:
        return {
            "style": normalized,
            "debug": {
                "selected_style": normalized,
                "factors": [{"source": "explicit_request", "weight": 1.0, "style": normalized}],
                "scores": {normalized: 1.0},
            },
        }

    scores: dict[str, float] = {"chat_balanced": 0.35, "chat_detailed": 0.30}
    factors: list[dict[str, Any]] = []

    if classification.request_type in {"web_query", "document_analysis"}:
        _style_weight(scores, factors, "request_type", "chat_detailed", 0.42, classification.request_type)
    elif classification.request_type in {"tool_call", "command_call"}:
        _style_weight(scores, factors, "request_type", "chat_balanced", 0.14, classification.request_type)

    if rendering_context is not None:
        care_style = str(getattr(rendering_context, "care_profile_response_style", "") or "").strip()
        if care_style in scores:
            _style_weight(scores, factors, "care_profile", care_style, 0.34, getattr(rendering_context, "care_profile_id", "profile"))
        sentence_length = str(getattr(rendering_context, "care_profile_sentence_length", "") or "").strip().lower()
        if sentence_length == "short":
            _style_weight(scores, factors, "care_profile_sentence_length", "chat_balanced", 0.18, sentence_length)
        elif sentence_length in {"long", "any"}:
            _style_weight(scores, factors, "care_profile_sentence_length", "chat_detailed", 0.18, sentence_length)

        behavior_style = str(getattr(rendering_context, "character_behavior_style", "") or "").strip().lower()
        if behavior_style:
            if re.search(r"\b(simple|brief|plain|minimal|concise|direct)\b", behavior_style):
                _style_weight(scores, factors, "character_behavior", "chat_balanced", 0.16, behavior_style[:80])
            if re.search(r"\b(detailed|scholarly|verbose|thorough|explanatory|teacher|storyteller)\b", behavior_style):
                _style_weight(scores, factors, "character_behavior", "chat_detailed", 0.16, behavior_style[:80])

    lowered_message = message.lower()
    if re.search(r"\b(briefly|short version|quick answer|quickly|keep it short|tldr|tl;dr|one sentence|summarize)\b", lowered_message):
        _style_weight(scores, factors, "user_request", "chat_balanced", 0.48, "asked_for_briefness")
    if re.search(r"\b(explain|why|how does|walk me through|step by step|in detail|more detail|go deeper|analyze|compare)\b", lowered_message):
        _style_weight(scores, factors, "user_request", "chat_detailed", 0.48, "asked_for_depth")
    if re.search(r"\b(confused|don't understand|unclear|what do you mean|help me understand)\b", lowered_message):
        _style_weight(scores, factors, "user_state", "chat_detailed", 0.22, "needs_clarity")

    recent_assistant_messages = [
        str(item.get("content") or "")
        for item in history[-6:]
        if str(item.get("role") or "") == "assistant"
    ]
    if recent_assistant_messages:
        average_length = sum(len(item) for item in recent_assistant_messages) / len(recent_assistant_messages)
        if average_length < 180:
            _style_weight(scores, factors, "conversation_state", "chat_detailed", 0.08, "recent_replies_short")
        elif average_length > 520:
            _style_weight(scores, factors, "conversation_state", "chat_balanced", 0.08, "recent_replies_long")

    variation_style = _variation_style(turn_id or message or classification.request_type)
    score_gap = abs(scores["chat_balanced"] - scores["chat_detailed"])
    if score_gap <= 0.14:
        _style_weight(scores, factors, "variety", variation_style, 0.06, f"gap={score_gap:.2f}")

    selected_style = "chat_balanced" if scores["chat_balanced"] >= scores["chat_detailed"] else "chat_detailed"
    return {
        "style": selected_style,
        "debug": {
            "selected_style": selected_style,
            "scores": {key: round(value, 3) for key, value in scores.items()},
            "factors": factors,
        },
    }


def _style_weight(
    scores: dict[str, float],
    factors: list[dict[str, Any]],
    source: str,
    style: str,
    weight: float,
    detail: str,
) -> None:
    """Apply one weighted style signal."""
    if style not in scores:
        return
    scores[style] += weight
    factors.append(
        {
            "source": source,
            "style": style,
            "weight": round(weight, 3),
            "detail": detail,
        }
    )


def _variation_style(seed: str) -> str:
    """Return a bounded style variation choice for one seed."""
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    return "chat_balanced" if int(digest[:2], 16) % 2 == 0 else "chat_detailed"


def generate_chat_assistant_message(
    connection: sqlite3.Connection,
    current_user: dict[str, Any],
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, Any],
    message: str,
    *,
    chat_id: Optional[str] = None,
    force_smart: bool = False,
    response_style: Optional[str] = None,
) -> dict[str, Any]:
    """Generate one assistant message for a chat turn."""
    from app.classifier import classify_message
    turn_id = uuid4().hex
    pre_classification = classify_message(message)
    if pre_classification.request_type == "image_generation":
        from app.subsystems.image import ImageGenerationError
        from app.orchestrator import route_image_generation
        try:
            gen_result = route_image_generation(message, profile, APP_CONFIG)
            return {
                "role": "assistant",
                "content": gen_result.reply,
                "meta": {
                    "request_type": gen_result.classification.request_type,
                    "route": gen_result.classification.route,
                    "reason": gen_result.classification.reason,
                    "execution": execution_meta(gen_result.provider),
                    "skill_route": None,
                    "turn_id": turn_id,
                    "voice_summary": "I generated an image for that request.",
                },
            }
        except ImageGenerationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    clarification = handle_pending_skill_clarification(
        connection,
        current_user,
        profile,
        history,
        providers,
        message,
        force_smart=force_smart,
    )
    if clarification is not None:
        return clarification
    active_providers = chat_providers(providers, force_smart=force_smart)
    
    is_standalone = pre_classification.request_type in ("image_generation", "web_query", "tool_call", "static_text", "command_call")
    resolved_message = message if is_standalone else reformulate_followup_query(message, history, active_providers)
    rendering_context = character_service.build_rendering_context(
        connection,
        current_user,
        profile,
        compiler_provider=active_providers["llm_thinking"],
    )
    skill_route = skill_service.inspect_route(
        connection,
        APP_CONFIG,
        current_user,
        profile,
        resolved_message,
    )
    skill_message = skill_service.route_and_execute(
        connection,
        APP_CONFIG,
        current_user,
        profile,
        resolved_message,
        turn_id=turn_id,
    )
    response_style_policy = resolve_response_style_policy(
        resolved_message,
        history,
        pre_classification,
        rendering_context,
        response_style,
        turn_id=turn_id,
    )
    chosen_response_style = str(response_style_policy["style"])
    if skill_message is not None:
        rendered_skill_message = render_skill_message(
            connection,
            current_user,
            profile,
            history,
            active_providers,
            resolved_message,
            skill_message["message"],
            skill_message.get("route"),
            turn_id=turn_id,
            response_style=chosen_response_style,
            response_style_debug=dict(response_style_policy.get("debug") or {}),
        )
        rendered_skill_message["meta"]["skill_route"] = skill_route
        return rendered_skill_message
    try:
        promoted_facts = memory_store.promote_person_facts(
            connection,
            current_user["id"],
            rendering_context.active_character_id if rendering_context else None,
            resolved_message,
            history,
        )
        dynamic_context = build_memory_context(
            connection,
            current_user["id"],
            character_id=rendering_context.active_character_id if rendering_context else None,
            chat_id=chat_id,
        )
        memory_debug = memory_debug_payload(
            connection,
            current_user["id"],
            character_id=rendering_context.active_character_id if rendering_context else None,
            chat_id=chat_id,
        )
        result = route_message(
            resolved_message,
            current_user["display_name"],
            profile,
            history,
            active_providers,
            rendering_context=rendering_context,
            dynamic_context=dynamic_context,
            response_style=chosen_response_style,
        )
    except (SkillExecutionError, Exception) as exc: # Fallback to generic since TextChatError not imported here
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    assistant_message = {
        "role": "assistant",
        "content": result.reply,
        "meta": assistant_message_meta(
            result.classification,
            result.provider,
            result,
            turn_id=turn_id,
            voice_summary=result.reply,
            response_style=chosen_response_style,
            response_style_debug=dict(response_style_policy.get("debug") or {}),
        ),
    }
    assistant_message["meta"]["memory_debug"] = memory_debug
    if promoted_facts:
        assistant_message["meta"]["memory_debug"]["promoted_facts"] = promoted_facts
    assistant_message["meta"]["skill_route"] = skill_route
    return assistant_message


def handle_pending_skill_clarification(
    connection: sqlite3.Connection,
    current_user: dict[str, Any],
    profile: str,
    history: list[dict[str, Any]],
    providers: dict[str, Any],
    message: str,
    *,
    force_smart: bool = False,
) -> Optional[dict[str, Any]]:
    """Resolve one pending skill clarification from recent chat history."""
    pending = _pending_skill_clarification(history)
    if pending is None:
        return None
    resolution = _resolve_clarification_candidate(message, pending["candidates"])
    if resolution is None:
        return None
    if isinstance(resolution, list):
        reply = _clarification_followup_reply(resolution)
        return {
            "role": "assistant",
            "content": reply,
            "meta": {
                "request_type": "skill_clarification",
                "route": "skill_clarification_followup",
                "reason": "Pending skill clarification still ambiguous.",
                "turn_id": uuid4().hex,
                "voice_summary": reply,
                "card": {"type": "clarification", "title": "Clarify request", "detail": reply},
                "skill_result": {
                    "ok": True,
                    "skill": str(pending.get("skill") or "skill"),
                    "action": str(pending.get("action") or "action"),
                    "presentation": {"type": "clarification"},
                    "data": {
                        "summary": reply,
                        "original_request": str(pending.get("original_request") or ""),
                        "account_label": str(pending.get("account_label") or ""),
                        "candidates": resolution,
                    },
                    "errors": [],
                },
            },
        }
    resolved_request = f"{pending['original_request']} {resolution['friendly_name']}".strip()
    return generate_chat_assistant_message(
        connection,
        current_user,
        profile,
        history[:-1],
        providers,
        resolved_request,
        force_smart=force_smart,
    )


def _pending_skill_clarification(history: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Return the latest pending skill clarification payload from chat history."""
    if not history:
        return None
    latest = history[-1]
    if str(latest.get("role") or "") != "assistant":
        return None
    skill_result = dict(latest.get("meta", {}).get("skill_result") or {})
    presentation = dict(skill_result.get("presentation") or {})
    data = dict(skill_result.get("data") or {})
    candidates = data.get("candidates") or []
    if str(presentation.get("type") or "") != "clarification" or not isinstance(candidates, list) or not candidates:
        return None
    original_request = str(data.get("original_request") or "").strip()
    if not original_request:
        return None
    return {
        "skill": str(skill_result.get("skill") or ""),
        "action": str(skill_result.get("action") or ""),
        "original_request": original_request,
        "account_label": str(data.get("account_label") or ""),
        "candidates": [item for item in candidates if isinstance(item, dict)],
    }


def _resolve_clarification_candidate(message: str, candidates: list[dict[str, Any]]) -> Union[dict[str, Any], list[dict[str, Any]], None]:
    """Return one resolved clarification candidate when the user's reply is specific enough."""
    cleaned = " ".join(str(message or "").lower().split())
    if not cleaned:
        return None
    cleaned_tokens = set(re.findall(r"[a-z0-9_']+", cleaned))
    if not cleaned_tokens:
        return None
    matches: list[dict[str, Any]] = []
    for candidate in candidates:
        friendly_name = str(candidate.get("friendly_name") or "").lower()
        entity_id = str(candidate.get("entity_id") or "").lower().replace("_", " ")
        haystack = f"{friendly_name} {entity_id}".strip()
        if not haystack:
            continue
        haystack_tokens = set(re.findall(r"[a-z0-9_']+", haystack))
        if cleaned in haystack or cleaned_tokens.issubset(haystack_tokens):
            matches.append(candidate)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        return matches
    return None


def _clarification_followup_reply(candidates: list[dict[str, Any]]) -> str:
    """Return a compact clarification follow-up for multiple remaining matches."""
    labels = [str(item.get("friendly_name") or "").strip() for item in candidates if str(item.get("friendly_name") or "").strip()]
    if not labels:
        return "I still see more than one match. Which one did you mean?"
    if len(labels) == 1:
        return f"Did you mean {labels[0]}?"
    return f"I still see more than one match. Did you mean {', '.join(labels[:-1])}, or {labels[-1]}?"


def render_skill_message(
    connection: sqlite3.Connection,
    current_user: dict[str, Any],
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, Any],
    user_message: str,
    skill_message: dict[str, Any],
    skill_route: Optional[dict[str, Any]] = None,
    *,
    turn_id: str = "",
    response_style: Optional[str] = None,
    response_style_debug: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Render one skill result through the character orchestration layer."""
    from app.subsystems.text import generate_text_reply
    skill_result, skill_context = skill_render_context(skill_message, skill_route)
    selected_response_style = str(
        dict(skill_message.get("meta", {})).get("render_payload", {}).get("response_style")
        or response_style
        or "chat_balanced"
    )
    if skill_should_skip_character_render(skill_message):
        skill_meta = dict(skill_message.get("meta", {}))
        return {
            "role": "assistant",
            "content": str(skill_message.get("content") or "").strip(),
            "meta": {
                **skill_meta,
                "turn_id": turn_id or str(skill_meta.get("turn_id") or ""),
                "voice_summary": str(skill_meta.get("voice_summary") or skill_message.get("content") or "").strip(),
                "response_style": str(dict(skill_meta.get("render_payload") or {}).get("response_style") or skill_meta.get("response_style") or selected_response_style),
                "response_style_debug": dict(response_style_debug or {}),
                "skill_result": skill_result,
            },
        }
    rendering_context = character_service.build_rendering_context(
        connection,
        current_user,
        profile,
        compiler_provider=providers["llm_thinking"],
    )
    render_classification = Classification(
        "skill_call",
        "character_render",
        "Skill result rendered through character orchestration.",
    )
    rendered = generate_text_reply(
        user_message,
        current_user["display_name"],
        profile,
        history,
        providers,
        render_classification,
        rendering_context=rendering_context,
        dynamic_context=skill_context,
        response_style=selected_response_style,
    )
    return {
        "role": "assistant",
        "content": rendered.reply,
        "meta": {
            **(skill_message.get("meta", {})),
            **assistant_message_meta(
                render_classification,
                rendered.provider,
                rendered,
                turn_id=turn_id or str(dict(skill_message.get("meta", {})).get("turn_id") or ""),
                voice_summary=str(dict(skill_message.get("meta", {})).get("voice_summary") or ""),
                response_style=selected_response_style,
                response_style_debug=dict(response_style_debug or {}),
            ),
            "skill_result": skill_result,
        },
    }


def chat_state_payload(
    connection: sqlite3.Connection,
    user_id: str,
    *,
    active_chat_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return sidebar chat state for one user."""
    active_chat = (
        chat_store.resolve_chat(connection, user_id, active_chat_id)
        if active_chat_id
        else chat_store.ensure_active_chat(connection, user_id)
    )
    return {
        "active_chat_id": str(active_chat["id"]),
        "history": chat_store.load_chat_history(connection, user_id, str(active_chat["id"])),
        "chats": chat_store.list_chat_summaries(connection, user_id),
    }


def _context_preview(context: str, limit: int = 220) -> str:
    """Return a compact single-line preview of one memory block."""
    cleaned = " ".join(line.strip() for line in context.splitlines() if line.strip())
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 3].rstrip()}..."
