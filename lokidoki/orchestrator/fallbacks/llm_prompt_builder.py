"""Prompt-building helpers for LLM synthesis.

Extracted from ``llm_fallback.py`` to keep each file under 300 lines.
The main entry point ``build_combine_prompt`` is re-exported from
``llm_fallback.py`` so existing imports continue to work.
"""
from __future__ import annotations

import json
import re
from typing import Any

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.core.types import ConstraintResult, RequestSpec
from lokidoki.orchestrator.fallbacks.prompts import (
    RESPONSE_SCHEMA_COMPARISON,
    RESPONSE_SCHEMA_RECOMMENDATION,
    RESPONSE_SCHEMA_TROUBLESHOOTING,
    RESPONSE_SCHEMA_UTILITY,
    render_prompt,
)


_STRUCTURAL_SOURCES = frozenset({
    "people_db", "home_assistant", "device_registry", "calendar",
    "contacts", "local_kb",
})


def _extract_persona(spec: RequestSpec) -> tuple[str, str]:
    """Return (character_name, behavior_prompt) from spec context.

    Falls back to "LokiDoki" / "" when persona is absent, so the
    templates always have a valid character_name.
    """
    ctx = spec.context if isinstance(spec.context, dict) else {}
    name = str(ctx.get("character_name") or "").strip() or "LokiDoki"
    behavior_prompt = str(ctx.get("behavior_prompt") or "").strip()
    
    # Allow persona prompts to use local context variables like {current_time}
    if behavior_prompt:
        current_time = ctx.get("current_time", "Unknown Time")
        # Surgical replacement to avoid breaking other braces in complex prompts
        behavior_prompt = behavior_prompt.replace("{current_time}", current_time)
        if not behavior_prompt.endswith("\n"):
            behavior_prompt += "\n"
    return name, behavior_prompt


def _build_confidence_guide(spec: RequestSpec) -> str:
    """Render per-chunk confidence annotations for the combine prompt.

    High-confidence chunks backed by structural sources (people_db,
    home_assistant, etc.) are marked as trustworthy pass-throughs.
    Low-confidence or borderline chunks get a warning so the LLM
    uses its own judgment instead of parroting potentially wrong
    skill output.
    """
    primary = [c for c in spec.chunks if c.role == "primary_request"]
    if not primary:
        return "No chunks to evaluate."
    lines: list[str] = []
    threshold = CONFIG.route_confidence_threshold
    for chunk in primary:
        source = (chunk.params.get("source") or "") if chunk.params else ""
        if chunk.confidence > threshold and source in _STRUCTURAL_SOURCES:
            lines.append(f'"{chunk.text}": high confidence, structural source — trust this result.')
        elif chunk.confidence > threshold:
            lines.append(f'"{chunk.text}": high confidence — use this result.')
        else:
            lines.append(f'"{chunk.text}": low confidence — this may not be relevant; use your judgment.')
    return " ".join(lines)


def _collect_sources(spec: RequestSpec) -> list[dict[str, str]]:
    """Collect deduplicated sources for the turn.

    Cutover (chunk 5): prefer ``spec.adapter_sources``, which the
    synthesis phase populates from every successful
    ``AdapterOutput.sources``. When it's empty — e.g. a fast-lane /
    direct_chat turn, or a skill whose adapter isn't registered yet —
    fall back to scraping ``chunk.result.sources`` so the LLM prompt
    never loses a source that was visible to the old path.

    Returns a stable-ordered list of ``{"url": ..., "title": ...}``
    dicts. The 1-based index in this list is the ``[src:N]`` citation
    marker the LLM should emit.
    """
    adapter_sources = list(getattr(spec, "adapter_sources", []) or [])
    if adapter_sources:
        cleaned: list[dict[str, str]] = []
        seen: set[str] = set()
        for src in adapter_sources:
            if not isinstance(src, dict):
                continue
            url = (src.get("url") or "").strip()
            # Match the legacy path: URL is required. URL-less entries
            # (offline snippets, search-preview rows without links) are
            # not citable by [src:N] markers and have historically been
            # dropped before reaching the prompt / frontend. Preserve
            # that behavior so the event payload stays byte-compatible.
            if not url or url in seen:
                continue
            seen.add(url)
            title = src.get("title") or url
            entry = {**src, "url": url, "title": title}
            cleaned.append(entry)
        return cleaned

    # Legacy fallback — kept for fast-lane / direct_chat / adapter-less
    # skills. Will be dropped in a later chunk once adapter coverage is
    # 100%.
    sources: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for chunk in spec.chunks:
        if chunk.role != "primary_request" or not chunk.success:
            continue
        result = chunk.result or {}
        for src in result.get("sources") or []:
            if not isinstance(src, dict):
                continue
            url = src.get("url") or ""
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            sources.append({
                **src,
                "url": url,
                "title": src.get("title") or url,
            })
        # Backwards-compat: legacy source_url/source_title fields
        legacy_url = result.get("source_url") or ""
        if legacy_url and legacy_url not in seen_urls:
            seen_urls.add(legacy_url)
            sources.append({
                **_sanitize_result(result),
                "url": legacy_url,
                "title": result.get("source_title") or legacy_url,
            })
    return sources


def _render_sources_list(sources: list[dict[str, str]]) -> str:
    """Render sources for the LLM prompt, e.g. ``[src:1] Title (url)``."""
    if not sources:
        return ""
    return " ".join(
        f"[src:{i}] {src['title']} ({src['url']})" + (f" [type:{src['type']}]" if src.get("type") else "")
        for i, src in enumerate(sources, 1)
    )


def _render_media_hint(spec: RequestSpec) -> str:
    """Tell the LLM about media cards the UI will render above its reply.

    Returns an empty string when no media is attached so non-media
    turns pay zero prompt-budget cost. When media is present, emits a
    short block combining (a) the card metadata and (b) the rule: do
    NOT deny the card's existence, because the user is literally about
    to see it.
    """
    cards = list(getattr(spec, "media", []) or [])
    if not cards:
        return ""
    lines: list[str] = []
    for card in cards:
        kind = str(card.get("kind") or "")
        if kind == "youtube_video":
            title = card.get("title") or "video"
            channel = card.get("channel") or card.get("channel_name") or ""
            suffix = f" by {channel}" if channel else ""
            lines.append(f"- YouTube video: {title}{suffix}")
        elif kind == "youtube_channel":
            name = card.get("channel_name") or "channel"
            handle = card.get("handle") or ""
            suffix = f" ({handle})" if handle else ""
            lines.append(f"- YouTube channel: {name}{suffix}")
        else:
            title = card.get("title") or card.get("url") or kind
            lines.append(f"- {kind}: {title}")
    return (
        "media_attached (already visible to the user above your reply — do NOT say you "
        "couldn't find it, and do NOT deny its existence):\n" + "\n".join(lines)
    )


def _sanitize_citations(text: str, source_count: int) -> str:
    """Clean up ``[src:N]`` markers the LLM may have mangled.

    - Non-numeric markers like ``[src:wikipedia]`` → dropped.
    - Out-of-range markers (N > source_count or N < 1) → dropped.
    - When source_count == 0, all ``[src:*]`` markers are stripped.
    """
    def _fix(match: re.Match) -> str:
        inner = match.group(1).strip()
        if not inner.isdigit():
            return ""
        idx = int(inner)
        if idx < 1 or idx > source_count:
            return ""
        return match.group(0)

    return re.sub(r"\[src:([^\]]*)\]", _fix, text).strip()


def _is_direct_chat_only(spec: RequestSpec) -> bool:
    """True when every primary chunk routed to ``direct_chat``."""
    primary = [chunk for chunk in spec.chunks if chunk.role == "primary_request"]
    if not primary:
        return False
    return all(chunk.capability == "direct_chat" for chunk in primary)


_METADATA_KEYS = frozenset({
    "source_url", "source_title", "source_type", "mechanism", "mechanisms_tried",
})


def _sanitize_result(result: dict | None) -> dict | None:
    """Strip internal metadata fields from a chunk result before LLM sees it.

    Source URLs and titles leak into the prompt and the LLM parrots them.
    The citation system uses _collect_sources separately, so removing
    these from the payload is safe.
    """
    if not result or not isinstance(result, dict):
        return result
    return {k: v for k, v in result.items() if k not in _METADATA_KEYS}


def _select_response_schema(spec: RequestSpec) -> str:
    """Pick a response-shape schema from constraint data or route heuristics.

    Returns an empty string when no schema matches, preserving the
    current generic prompt behavior.
    """
    ctx = spec.context if isinstance(spec.context, dict) else {}

    # Prefer structured constraint data from Chunk 4's extractor.
    constraints = ctx.get("constraints")
    if isinstance(constraints, ConstraintResult):
        if constraints.is_comparison:
            return RESPONSE_SCHEMA_COMPARISON
        if constraints.is_recommendation:
            return RESPONSE_SCHEMA_RECOMMENDATION

    # Route-based heuristics: check capabilities for shape signals.
    for chunk in spec.chunks:
        if chunk.role != "primary_request":
            continue
        cap = (chunk.capability or "").lower()
        if "compare" in cap:
            return RESPONSE_SCHEMA_COMPARISON
        if "recommend" in cap or "suggestion" in cap:
            return RESPONSE_SCHEMA_RECOMMENDATION
        if "troubleshoot" in cap or "diagnose" in cap or "fix" in cap:
            return RESPONSE_SCHEMA_TROUBLESHOOTING

    # direct_chat with no skill data → utility (concise direct answer).
    if _is_direct_chat_only(spec):
        return RESPONSE_SCHEMA_UTILITY

    return ""


def build_llm_payload(spec: RequestSpec) -> dict[str, Any]:
    """Serialise a RequestSpec into the structured payload LLM sees."""
    return {
        "trace_id": spec.trace_id,
        "original_request": spec.original_request,
        "chunks": [
            {
                "text": chunk.text,
                "role": chunk.role,
                "capability": chunk.capability,
                "confidence": chunk.confidence,
                "params": chunk.params,
                "result": _sanitize_result(chunk.result),
                "unresolved": chunk.unresolved,
                "success": chunk.success,
                "error": chunk.error,
            }
            for chunk in spec.chunks
        ],
        "supporting_context": spec.supporting_context,
        "context_keys": sorted(spec.context.keys()) if isinstance(spec.context, dict) else [],
    }


def build_combine_prompt(spec: RequestSpec) -> str:
    """Render the combine prompt that the LLM client would send.

    Two prompt families:

    * ``direct_chat`` — when the router fell through with no matching
      skill, the only thing in the spec is the user's verbatim
      utterance. We render the ``direct_chat`` template so LLM
      answers the question directly from its own knowledge instead of
      writing a meta-summary about the spec.
    * ``combine`` — when one or more skills produced output and we
      just need to weave them into a single natural-language reply.
    """
    memory_slots = _extract_memory_slots(spec)
    character_name, behavior_prompt = _extract_persona(spec)

    current_time = spec.context.get("current_time", "Unknown Time")
    user_name = spec.context.get("user_name", "User")
    response_schema = _select_response_schema(spec)

    if _is_direct_chat_only(spec):
        return render_prompt(
            "direct_chat",
            user_question=spec.original_request,
            character_name=character_name,
            behavior_prompt=behavior_prompt,
            current_time=current_time,
            user_name=user_name,
            response_schema=response_schema,
            **memory_slots,
        )
    payload = build_llm_payload(spec)
    sources = _collect_sources(spec)
    return render_prompt(
        "combine",
        spec=json.dumps(payload, ensure_ascii=False),
        character_name=character_name,
        behavior_prompt=behavior_prompt,
        confidence_guide=_build_confidence_guide(spec),
        sources_list=_render_sources_list(sources),
        media_hint=_render_media_hint(spec),
        current_time=current_time,
        user_name=user_name,
        response_schema=response_schema,
        **memory_slots,
    )


def _extract_memory_slots(spec: RequestSpec) -> dict[str, str]:
    """Extract the memory slot strings from spec.context."""
    keys = ("user_facts", "social_context", "recent_context", "relevant_episodes", "user_style", "recent_mood")
    if not isinstance(spec.context, dict):
        return {k: "" for k in keys} | {"conversation_history": ""}
    slots = spec.context.get("memory_slots") or {}
    if not isinstance(slots, dict):
        slots = {}
    result = {k: str(slots.get(k) or "") for k in keys}
    # Conversation history comes from context directly (set in chat.py),
    # not from memory_slots. Render it here.
    from lokidoki.orchestrator.memory.slot_renderers import render_conversation_history
    raw_history = spec.context.get("conversation_history") or []
    # Extract last assistant message for the dedicated follow-up slot.
    # Strip it from the history list to avoid sending it twice.
    last_asst = ""
    deduped_history = list(raw_history)
    if deduped_history:
        # Walk backwards to find the last assistant message.
        for i in range(len(deduped_history) - 1, -1, -1):
            m = deduped_history[i] if isinstance(deduped_history[i], dict) else dict(deduped_history[i])
            if m.get("role") == "assistant" and m.get("content"):
                last_asst = m["content"].strip()
                if len(last_asst) > 300:
                    last_asst = last_asst[:297].rsplit(" ", 1)[0] + "..."
                deduped_history = deduped_history[:i] + deduped_history[i + 1:]
                break
    result["conversation_history"] = render_conversation_history(deduped_history) if deduped_history else ""
    result["last_assistant_msg"] = (
        f"YOUR LAST MESSAGE (fulfill any offer if user confirms):\n{last_asst}"
        if last_asst else ""
    )
    return result


def build_split_prompt(utterance: str, context: dict[str, Any] | None = None) -> str:
    """Render the split prompt for ambiguous compound utterances."""
    ctx = context or {}
    current_time = ctx.get("current_time", "Unknown Time")
    user_name = ctx.get("user_name", "User")
    return render_prompt("split", utterance=utterance, current_time=current_time, user_name=user_name)


def build_resolve_prompt(
    *,
    chunk_text: str,
    capability: str,
    unresolved: list[str],
    context: dict[str, Any],
) -> str:
    """Render the resolve prompt for chunks the deterministic resolver could not bind."""
    current_time = context.get("current_time", "Unknown Time")
    user_name = context.get("user_name", "User")
    return render_prompt(
        "resolve",
        chunk_text=chunk_text,
        capability=capability,
        unresolved=json.dumps(unresolved, ensure_ascii=False),
        context=json.dumps(context, ensure_ascii=False),
        current_time=current_time,
        user_name=user_name,
    )
