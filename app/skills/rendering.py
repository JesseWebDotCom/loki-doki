"""Helpers for skill-result rendering."""

from __future__ import annotations

import json
from typing import Any, Optional


def skill_should_skip_character_render(skill_message: dict[str, Any]) -> bool:
    """Return True when a structured skill reply must bypass character rendering."""
    del skill_message
    return False


def skill_render_context(
    skill_message: dict[str, Any],
    skill_route: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, Any], str]:
    """Return skill-result data and the summary text for character rendering."""
    del skill_route
    skill_result = skill_message.get("meta", {}).get("skill_result", {})
    render_payload = skill_message.get("meta", {}).get("render_payload")
    if not isinstance(render_payload, dict) or not render_payload:
        skill_summary = str(skill_message.get("content") or "").strip()
        return skill_result, skill_summary

    presentation = str(render_payload.get("presentation_type") or "")

    if presentation in {"entity_state_change", "entity_state"}:
        return skill_result, (
            "Verified device-control result from a skill.\n"
            "Respond through the compiled prompt voice, but preserve the verified facts exactly.\n"
            "Do not suggest manual steps like using a switch or remote.\n"
            "Do not present the action as future tense or a suggestion; it already happened.\n"
            "Do not infer or invent a room, device name, or location that is not explicitly present in the payload.\n"
            "If the payload only gives a generic device label, keep your wording generic.\n"
            "Keep the reply short and natural.\n"
            f"{json.dumps(render_payload, ensure_ascii=True, sort_keys=True)}"
        )

    if presentation == "wikipedia_summary":
        return skill_result, _wikipedia_render_context(render_payload)

    # Generic skill result
    response_style = str(render_payload.get("response_style") or "chat_balanced")
    rules = (
        "PRESENTATION RULES (STRICT):\n"
        f"1. The required response style is {response_style}.\n"
        "2. Write plain natural prose for chat. Do not use Markdown headings, bullet lists, or image embeds.\n"
        "3. Keep the answer compact unless the payload clearly requires extra detail.\n"
        "4. If sources are present, mention them naturally in sentence form instead of inline citation formatting.\n"
        "5. Do not end with a follow-up question unless the payload explicitly calls for clarification.\n"
        "6. Preserve verified facts exactly and do not invent missing details."
    )
    return skill_result, (
        f"{rules}\n\n"
        "Verified skill result. Use this structured payload as grounding, not as a script.\n"
        "Do not mechanically read every field or invent missing values.\n"
        f"{json.dumps(render_payload, ensure_ascii=True, sort_keys=True)}"
    )


def _wikipedia_render_context(render_payload: dict[str, Any]) -> str:
    """Build the LLM rendering context for a Wikipedia result."""
    data = dict(render_payload.get("data") or {})
    title = str(data.get("title") or "")
    description = str(data.get("description") or "")
    extract = str(data.get("extract") or "")
    page_url = str(data.get("page_url") or "")
    thumbnail = dict(data.get("thumbnail") or {})
    infobox = dict(data.get("infobox") or {})

    voice_summary = str(render_payload.get("voice_summary") or "").strip()
    source_metadata = list(render_payload.get("source_metadata") or [])
    response_style = str(render_payload.get("response_style") or "chat_detailed")

    # Build a structured context block — the LLM decides the prose
    context_lines = ["## Wikipedia Article Data"]
    context_lines.append(f"Title: {title}")
    if description:
        context_lines.append(f"Description: {description}")
    if infobox:
        context_lines.append(f"Infobox facts: {json.dumps(infobox, ensure_ascii=False)}")
    if extract:
        context_lines.append(f"\nIntro extract (verbatim Wikipedia text):\n{extract}")
    if page_url:
        context_lines.append(f"Wikipedia page URL: {page_url}")
    if voice_summary:
        context_lines.append(f"Preferred short spoken summary: {voice_summary}")
    if source_metadata:
        context_lines.append(f"Normalized sources: {json.dumps(source_metadata, ensure_ascii=False)}")

    context = "\n".join(context_lines)

    rules = (
        "PRESENTATION RULES (STRICT):\n"
        f"1. The required response style is {response_style}.\n"
        "2. Write a clean, natural answer in plain prose with no Markdown headings or bulleted lists.\n"
        "3. Lead with the most useful summary first.\n"
        "4. Use the extract and infobox to enrich the answer, but do not copy Wikipedia text verbatim.\n"
        "5. If the source matters, mention Wikipedia naturally in the sentence instead of link formatting.\n"
        "6. Do not add a follow-up question unless it would genuinely help the user continue."
    )

    return f"{rules}\n\n{context}"
