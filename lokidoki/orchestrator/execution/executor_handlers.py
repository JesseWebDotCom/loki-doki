"""Built-in deterministic handlers and handler resolution for the executor."""
from __future__ import annotations

import importlib
import logging
from datetime import datetime
from typing import Any, Callable, Awaitable

log = logging.getLogger("lokidoki.orchestrator.executor")

HandlerFn = Callable[[dict[str, Any]], Any | Awaitable[Any]]


# ---- built-in deterministic handlers ----------------------------------------


def _greeting_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": "Hello."}


def _ack_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": "You're welcome."}


def _spell_handler(payload: dict[str, Any]) -> dict[str, Any]:
    word = str(payload.get("resolved_target") or "").strip()
    return {"output_text": word}


def _time_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": datetime.now().strftime("%-I:%M %p")}


def _date_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": datetime.now().strftime("%A, %B %-d, %Y")}


def _recall_media_handler(payload: dict[str, Any]) -> dict[str, Any]:
    unresolved = payload.get("unresolved") or []
    if "recent_media" in unresolved:
        return {"output_text": "I don't have a recent movie in context yet."}
    if "recent_media_ambiguous" in unresolved:
        candidates = ", ".join(payload.get("candidate_values") or [])
        return {"output_text": f"I found multiple recent movies: {candidates}."}
    return {"output_text": payload.get("resolved_target") or ""}


def _person_birthday_handler(payload: dict[str, Any]) -> dict[str, Any]:
    """Look up the resolved person's birthday from the people DB params."""
    params = payload.get("params") or {}
    name = params.get("person_name") or payload.get("resolved_target") or ""
    birthday = params.get("birthday")
    if not name:
        return {"output_text": "I'm not sure which person you mean."}
    if not birthday:
        return {"output_text": f"I don't have a birthday on file for {name}."}
    return {"output_text": f"{name}'s birthday is {birthday}."}


def _echo_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": str(payload.get("chunk_text") or "")}


BUILTIN_HANDLERS: dict[str, HandlerFn] = {
    "core.greetings.reply": _greeting_handler,
    "core.acknowledgments.reply": _ack_handler,
    "core.dictionary.spell": _spell_handler,
    "core.dictionary.spell_fallback": _spell_handler,
    "core.time.get_local_time": _time_handler,
    "core.time.get_local_time_backup": _time_handler,
    "core.date.get_local_date": _date_handler,
    "context.media.recall_recent": _recall_media_handler,
    "core.people.birthday": _person_birthday_handler,
    "fallback.direct_chat": _echo_handler,
}

# ---- registry-driven skill handler map --------------------------------------

_skill_handler_map_cache: dict[str, tuple[str, str]] | None = None


def get_skill_handler_map() -> dict[str, tuple[str, str]]:
    """Return the lazily-built skill handler map from the registry."""
    global _skill_handler_map_cache  # noqa: PLW0603
    if _skill_handler_map_cache is None:
        from lokidoki.orchestrator.registry.loader import build_handler_map
        _skill_handler_map_cache = build_handler_map()
    return _skill_handler_map_cache


# ---- handler resolution with lazy loading -----------------------------------

_resolved_cache: dict[str, HandlerFn] = {}


def resolve_handler(handler_name: str) -> HandlerFn:
    """Resolve a dotted handler name to a callable, caching the result."""
    if handler_name in _resolved_cache:
        return _resolved_cache[handler_name]
    if handler_name in BUILTIN_HANDLERS:
        return BUILTIN_HANDLERS[handler_name]
    spec = get_skill_handler_map().get(handler_name)
    if spec is None:
        return _echo_handler
    module_path, attr_name = spec
    try:
        module = importlib.import_module(module_path)
        handler = getattr(module, attr_name)
        _resolved_cache[handler_name] = handler
        return handler
    except (ImportError, AttributeError) as exc:
        log.warning("handler %s unavailable: %s", handler_name, exc)
        _resolved_cache[handler_name] = _echo_handler
        return _echo_handler


def register_handler(name: str, handler: HandlerFn) -> None:
    """Register or replace a handler at runtime (used by tests)."""
    _resolved_cache[name] = handler


def list_handlers() -> tuple[str, ...]:
    all_names = set(BUILTIN_HANDLERS) | set(get_skill_handler_map()) | set(_resolved_cache)
    return tuple(sorted(all_names))
