"""Message rendering and final prompt orchestration."""

from __future__ import annotations

import json
from typing import Any

from app.subsystems.character.models import CharacterRenderingContext, ParsedModelResponse


def build_messages(
    context: CharacterRenderingContext,
    classification: str,
    message: str,
    history: list[dict[str, str]],
    dynamic_context: str = "",
    response_style: str = "balanced",
) -> list[dict[str, str]]:
    """Build the final chat message list for the model."""
    if classification == "character_render" and dynamic_context.strip():
        dynamic_prompt = (
            "USER MESSAGE:\n"
            f"{message.strip()}\n\n"
            "RESEARCH:\n"
            f"{dynamic_context.strip()}\n\n"
            "Use the research as source-of-truth context. Follow the system prompt and answer the user naturally.\n"
        )
    else:
        dynamic_prompt = ""
        if dynamic_context.strip():
            dynamic_prompt += "## Research Data (Source of Truth)\n"
            dynamic_prompt += f"{dynamic_context.strip()}\n\n"
        dynamic_prompt += "## User Message\n"
        dynamic_prompt += f"{message.strip()}\n"
        
    messages: list[dict[str, str]] = [
        {"role": "system", "content": context.base_prompt},
    ]
    # Recent history
    for item in history[-12:]:
        messages.append(item)
    messages.append({"role": "user", "content": dynamic_prompt})
    
    messages.append(
        {
            "role": "user",
            "content": _response_style_instruction(response_style, classification),
        }
    )
    return messages


def _response_style_instruction(response_style: str, classification: str) -> str:
    """Return the final style instruction for one rendered response."""
    if response_style == "brief":
        return (
            "Instruction: Answer in one or two short natural sentences. "
            "Do not use Markdown headings or bullet lists. "
            "Do not ask a follow-up question. Stay in character."
        )
    if response_style == "detailed":
        allow_followup = classification in ("web_query", "wikipedia_summary", "character_render", "skill_call")
        if allow_followup:
            return (
                "Instruction: Provide a detailed but natural response in plain prose. "
                "Do not use Markdown headings or bullet lists unless the user explicitly asks for them. "
                "You may end with one specific follow-up question if it genuinely helps."
            )
        return (
            "Instruction: Provide a detailed but natural response in plain prose. "
            "Do not use Markdown headings or bullet lists unless the user explicitly asks for them. "
            "Do not ask a follow-up question."
        )
    return (
        "Instruction: Give a clear, natural response in a short paragraph or two. "
        "Do not use Markdown headings or bullet lists unless the user explicitly asks for them. "
        "Do not ask a follow-up question unless clarification is required. Stay in character."
    )


def parse_model_response(raw_text: str) -> ParsedModelResponse | None:
    """Parse one JSON-first model response."""
    cleaned = raw_text.strip()
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    final_text = str(payload.get("final_text") or "").strip()
    if not final_text:
        return ParsedModelResponse(
            summary=cleaned[:140],
            metadata={},
            final_text=cleaned,
            raw_text=raw_text,
        )
    summary = str(payload.get("summary") or final_text[:140]).strip()
    return ParsedModelResponse(summary=summary, metadata=payload.get("metadata", {}), final_text=final_text, raw_text=raw_text)


def blocked_topic_reply(context: CharacterRenderingContext, message: str) -> str | None:
    """Return a deterministic blocked-topic reply if any blocked topic matches."""
    lowered = f" {message.lower()} "
    from app.subsystems.character.models import DEFAULT_BLOCKED_TOPIC_REPLY
    for topic in context.blocked_topics:
        if f" {topic.lower()} " in lowered:
            return f"{context.display_name}, {DEFAULT_BLOCKED_TOPIC_REPLY}"
    return None
