"""Response generation for structured skill results."""

from __future__ import annotations

from typing import Any, Optional, Union

MAX_RENDER_LIST_ITEMS = 5
MAX_RENDER_DICT_ITEMS = 10
MAX_RENDER_STRING_LENGTH = 2000


def build_skill_reply(result: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Return one voice reply and screen card for a skill result."""
    skill_id = str(result.get("skill", "skill"))
    action = str(result.get("action", "action"))
    data = dict(result.get("data") or {})
    presentation = dict(result.get("presentation") or {})
    errors = list(result.get("errors") or [])
    if not result.get("ok", False):
        detail = errors[0] if errors else f"{skill_id}.{action} failed."
        return detail, {"type": "error", "title": skill_id, "detail": detail}
    if presentation.get("type") == "search_results":
        return _search_reply(data)
    if presentation.get("type") == "wikipedia_summary":
        return _wikipedia_reply(data)
    if presentation.get("type") == "weather_report":
        return _weather_reply(data)
    if presentation.get("type") == "clarification":
        detail = str(data.get("summary") or "I need a bit more detail before I run that.")
        return detail, {"type": "clarification", "title": skill_id, "detail": detail, "data": data}
    if presentation.get("type") == "entity_state_change":
        summary = str(data.get("summary") or "").strip()
        if summary:
            entity = str(data.get("friendly_name") or data.get("entity_id") or "Home Assistant")
            return summary, {"type": "entity_state_change", "title": entity, "detail": summary}
        entity = str(data.get("friendly_name") or data.get("entity_id", "That device"))
        state = str(data.get("state", "updated"))
        reply = f"{entity} is now {state}."
        return reply, {"type": "entity_state_change", "title": entity, "detail": reply}
    if presentation.get("type") == "entity_state":
        summary = str(data.get("summary") or "").strip()
        if summary:
            entity = str(data.get("friendly_name") or data.get("entity_id") or "Home Assistant")
            return summary, {"type": "entity_state", "title": entity, "detail": summary}
        entity = str(data.get("friendly_name") or data.get("entity_id", "That device"))
        state = str(data.get("state", "unknown"))
        reply = f"{entity} is currently {state}."
        return reply, {"type": "entity_state", "title": entity, "detail": reply}
    title = f"{skill_id}.{action}"
    reply = str(data.get("summary") or f"{title} completed successfully.")
    return reply, {"type": presentation.get("type", "summary"), "title": title, "detail": reply}


def build_skill_render_payload(
    result: dict[str, Any],
    reply: str,
    card: Optional[dict[str, Any]] = None,
    route: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Return a compact generic payload for final character rendering."""
    del card
    payload = {
        "ok": bool(result.get("ok", False)),
        "skill": str(result.get("skill") or "skill"),
        "action": str(result.get("action") or "action"),
        "presentation_type": str(dict(result.get("presentation") or {}).get("type") or ""),
        "reply": reply.strip(),
        "voice_summary": reply.strip(),
        "response_style": _response_style(result),
        "data": _compact_value(dict(result.get("data") or {}), depth=0),
        "source_metadata": _source_metadata(result),
        "media": _media_metadata(result),
        "errors": [str(item) for item in list(result.get("errors") or [])[:3]],
        "route": dict(route or {}),
    }
    return payload


def clarification_reply(reason: str) -> tuple[str, dict[str, Any]]:
    """Return a user-facing clarification payload."""
    reply = reason or "I’m not sure which skill you meant."
    return reply, {"type": "clarification", "title": "Clarify request", "detail": reply}


def _search_reply(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Build a compact search response."""
    results = list(data.get("results") or [])
    if not results:
        reply = "I couldn’t find any search results for that."
        return reply, {"type": "search_results", "title": "No results", "items": []}
    top = dict(results[0])
    title = str(top.get("title") or "Top result")
    snippet = str(top.get("snippet") or "").strip()
    reply = title if not snippet else f"{title}. {snippet}"
    return reply, {"type": "search_results", "title": data.get("query", "Search"), "items": results[:5]}


def _wikipedia_reply(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Build a compact Wikipedia summary response."""
    title = str(data.get("title") or "Wikipedia")
    extract = str(data.get("extract") or "").strip()
    if not extract:
        reply = f"I found a Wikipedia article for '{title}', but it doesn't have a summary."
        return reply, {"type": "wikipedia_summary", "title": title, "detail": reply}
    
    # Use the description for a brief summary if available, then the extract
    description = str(data.get("description") or "").strip()
    if description:
        reply = f"{title}, {description.lower().strip('.')}. {extract}"
    else:
        reply = f"{title}. {extract}"
    
    return reply, {"type": "wikipedia_summary", "title": title, "detail": reply, "data": data}


def _weather_reply(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Build a compact weather response."""
    summary = str(data.get("summary") or "").strip()
    if summary:
        location = _display_location(str(data.get("location", "that location")))
        return summary, {"type": "weather_report", "title": f"Weather for {location}", "detail": summary, "data": data}
    location = _display_location(str(data.get("location", "that location")))
    condition = str(data.get("condition", "current conditions"))
    high = str(data.get("high_temp_f", "?"))
    low = str(data.get("low_temp_f", "?"))
    reply = f"In {location}, it’s {condition.lower()} with a high of {high} F and a low of {low} F."
    return reply, {"type": "weather_report", "title": f"Weather for {location}", "detail": reply, "data": data}


def _display_location(location: str) -> str:
    """Return a more readable location label for voice replies."""
    stripped = location.strip()
    if stripped.islower():
        return stripped.title()
    return stripped or "that location"


def _compact_value(value: Any, depth: int) -> Any:
    """Return a bounded JSON-safe structure for prompt grounding."""
    if isinstance(value, dict):
        if depth >= 2:
            return {key: _compact_scalar(item) for key, item in list(value.items())[:MAX_RENDER_DICT_ITEMS]}
        compact: dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_RENDER_DICT_ITEMS]:
            compact[str(key)] = _compact_value(item, depth + 1)
        return compact
    if isinstance(value, list):
        return [_compact_value(item, depth + 1) for item in value[:MAX_RENDER_LIST_ITEMS]]
    return _compact_scalar(value)


def _compact_scalar(value: Any) -> Any:
    """Return one bounded scalar for prompt grounding."""
    if isinstance(value, str):
        stripped = value.strip()
        if len(stripped) <= MAX_RENDER_STRING_LENGTH:
            return stripped
        return f"{stripped[:MAX_RENDER_STRING_LENGTH].rstrip()}..."
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value).strip()[:MAX_RENDER_STRING_LENGTH]


def _source_metadata(result: dict[str, Any]) -> list[dict[str, str]]:
    """Return normalized source metadata for one skill result."""
    data = dict(result.get("data") or {})
    presentation = dict(result.get("presentation") or {})
    source_name = str(dict(result.get("meta") or {}).get("source") or result.get("skill") or "").strip()
    
    # 1. Prefer explicit standardized sources array
    raw_sources = list(result.get("sources") or [])
    if raw_sources:
        return [
            {
                "title": str(s.get("label") or s.get("title") or "Source"),
                "url": str(s.get("url") or ""),
                "snippet": str(s.get("snippet") or ""),
                "source": source_name or "skill",
            }
            for s in raw_sources if s.get("url")
        ]

    # 2. Fallback to legacy presentation-specific logic
    sources: list[dict[str, str]] = []
    if str(presentation.get("type") or "") == "search_results":
        for item in list(data.get("results") or [])[:5]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            url = str(item.get("url") or "").strip()
            snippet = str(item.get("snippet") or "").strip()
            if title or url or snippet:
                sources.append(
                    {
                        "title": title,
                        "url": url,
                        "snippet": snippet,
                        "source": source_name or "search",
                    }
                )
        return sources
    return sources


def _media_metadata(result: dict[str, Any]) -> list[dict[str, str]]:
    """Return normalized media attachments for one skill result."""
    presentation = dict(result.get("presentation") or {})
    media = list(presentation.get("media") or [])
    if not media:
        # Fallback to single poster/image in data if present
        data = dict(result.get("data") or {})
        poster_url = str(data.get("poster_url") or data.get("image_url") or "").strip()
        if poster_url:
            return [{"type": "poster", "url": poster_url}]
        return []
    
    return [
        {
            "type": str(m.get("type") or "image"),
            "url": str(m.get("url") or ""),
            "alt": str(m.get("alt") or m.get("title") or ""),
        }
        for m in media if m.get("url")
    ]


def _response_style(result: dict[str, Any]) -> str:
    """Return the preferred chat response style for one skill result."""
    presentation = str(dict(result.get("presentation") or {}).get("type") or "")
    if presentation in {"search_results", "wikipedia_summary"}:
        return "detailed"
    return "balanced"
