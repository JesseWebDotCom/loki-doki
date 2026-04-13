"""Capability execution for the pipeline.

Each handler is dispatched through :func:`run_handler`, which adds a
per-call timeout and a configurable retry budget. The executor never
raises into the pipeline — failures are captured on
:class:`ExecutionResult` so the combiner / LLM fallback can decide
how to surface them.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import time
from datetime import datetime
from typing import Any, Awaitable, Callable

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    ImplementationSelection,
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)
from lokidoki.orchestrator.execution.errors import HandlerError, HandlerTimeout, TransientHandlerError

log = logging.getLogger("lokidoki.orchestrator.executor")

HandlerFn = Callable[[dict[str, Any]], Any | Awaitable[Any]]


def execute_chunk(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> ExecutionResult:
    """Synchronous capability execution path used by tests / fast paths.
    Note: This path does NOT support per-user config injection.
    """
    handler = _resolve_handler(implementation.handler_name)
    payload = _build_payload_sync(chunk, route, implementation, resolution)
    output_text, raw_result, attempts, error = _run_blocking(handler, payload)
    return ExecutionResult(
        chunk_index=chunk.index,
        capability=route.capability,
        output_text=output_text,
        success=error is None,
        error=error,
        attempts=attempts,
        handler_name=implementation.handler_name,
        raw_result=raw_result,
    )


async def execute_chunk_async(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
    *,
    budget_ms: int | None = None,
    context: dict[str, Any] | None = None,
) -> ExecutionResult:
    """Async capability execution path used by the main pipeline.

    ``budget_ms`` overrides the default handler timeout when the registry
    specifies a per-capability ``max_chunk_budget_ms``.
    """
    handler = _resolve_handler(implementation.handler_name)
    payload = await _build_payload_async(chunk, route, implementation, resolution, context=context)
    timeout_s = budget_ms / 1000.0 if budget_ms else CONFIG.handler_timeout_s
    output_text, raw_result, attempts, error = await _run_with_retries(handler, payload, timeout_s=timeout_s)
    return ExecutionResult(
        chunk_index=chunk.index,
        capability=route.capability,
        output_text=output_text,
        success=error is None,
        error=error,
        attempts=attempts,
        handler_name=implementation.handler_name,
        raw_result=raw_result,
    )


async def _build_payload_async(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    user_id = (context or {}).get("owner_user_id")
    # prioritized memory_provider (lokidoki.db) for settings config
    memory = (context or {}).get("memory_provider") or (context or {}).get("memory_store")
    skill_id = implementation.skill_id
    merged_config = {}

    if skill_id and user_id and memory:
        try:
            from lokidoki.core import skill_config as cfg

            def _load(conn):
                return cfg.get_merged_config(conn, user_id, skill_id)

            merged_config = await memory.run_sync(_load)
        except Exception:
            log.exception("config injection failed for %s", skill_id)

    return {
        "chunk_text": chunk.text,
        "capability": route.capability,
        "resolved_target": resolution.resolved_target,
        "params": dict(resolution.params),
        "context_value": resolution.context_value,
        "candidate_values": list(resolution.candidate_values),
        "unresolved": list(resolution.unresolved),
        "owner_user_id": user_id,
        "memory_provider": memory,
        "skill_id": skill_id,
        "_config": merged_config,
    }


def _build_payload_sync(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> dict[str, Any]:
    """Sync version for internal/test use (no injection Support)."""
    return {
        "chunk_text": chunk.text,
        "capability": route.capability,
        "resolved_target": resolution.resolved_target,
        "params": dict(resolution.params),
        "context_value": resolution.context_value,
        "candidate_values": list(resolution.candidate_values),
        "unresolved": list(resolution.unresolved),
        "skill_id": implementation.skill_id,
        "_config": {},
    }


def _run_blocking(
    handler: HandlerFn,
    payload: dict[str, Any],
) -> tuple[str, dict[str, Any], int, str | None]:
    last_error: str | None = None
    attempts = 0
    for attempt in range(CONFIG.handler_retries + 1):
        attempts = attempt + 1
        try:
            raw = handler(payload)
            if inspect.isawaitable(raw):
                raw = asyncio.run(raw)  # pragma: no cover - sync path used in tests
            text, blob = _normalize_handler_result(raw)
            return text, blob, attempts, None
        except TransientHandlerError as exc:
            last_error = str(exc)
            time.sleep(CONFIG.handler_retry_backoff_s)
        except HandlerError as exc:
            return "", {}, attempts, str(exc)
        except Exception as exc:  # noqa: BLE001 - handlers are untrusted
            log.exception("handler %s raised", handler)
            return "", {}, attempts, str(exc)
    return "", {}, attempts, last_error or "exhausted retries"


async def _run_with_retries(
    handler: HandlerFn,
    payload: dict[str, Any],
    *,
    timeout_s: float | None = None,
) -> tuple[str, dict[str, Any], int, str | None]:
    effective_timeout = timeout_s or CONFIG.handler_timeout_s
    last_error: str | None = None
    attempts = 0
    for attempt in range(CONFIG.handler_retries + 1):
        attempts = attempt + 1
        try:
            raw = await asyncio.wait_for(
                _invoke(handler, payload),
                timeout=effective_timeout,
            )
            text, blob = _normalize_handler_result(raw)
            return text, blob, attempts, None
        except asyncio.TimeoutError:
            last_error = f"handler timed out after {effective_timeout}s"
            log.warning("handler timeout: %s", handler)
        except TransientHandlerError as exc:
            last_error = str(exc)
        except HandlerError as exc:
            return "", {}, attempts, str(exc)
        except Exception as exc:  # noqa: BLE001 - handlers are untrusted
            log.exception("handler %s raised", handler)
            return "", {}, attempts, str(exc)
        await asyncio.sleep(CONFIG.handler_retry_backoff_s)
    return "", {}, attempts, last_error or "exhausted retries"


async def _invoke(handler: HandlerFn, payload: dict[str, Any]) -> Any:
    if inspect.iscoroutinefunction(handler):
        return await handler(payload)
    return await asyncio.to_thread(handler, payload)


def _normalize_handler_result(raw: Any) -> tuple[str, dict[str, Any]]:
    if raw is None:
        return "", _empty_result_blob()
    if isinstance(raw, dict):
        text = str(raw.get("output_text") or raw.get("text") or "").strip()
        blob = _ensure_standard_fields(raw)
        return text, blob
    if isinstance(raw, str):
        return raw.strip(), _ensure_standard_fields({"output_text": raw})
    text = str(raw)
    return text, _ensure_standard_fields({"output_text": text})


def _empty_result_blob() -> dict[str, Any]:
    return {
        "output_text": "",
        "success": True,
        "error_kind": "none",
        "mechanism_used": "",
        "data": None,
        "sources": [],
    }


def _ensure_standard_fields(blob: dict[str, Any]) -> dict[str, Any]:
    """Backfill missing standard contract fields so consumers see a uniform shape."""
    blob.setdefault("success", True)
    blob.setdefault("error_kind", "none")
    blob.setdefault("mechanism_used", "")
    blob.setdefault("data", None)
    blob.setdefault("sources", [])
    return blob


# ---- handler resolution with lazy loading -----------------------------------
#
# Skill modules are loaded on first use instead of at import time. This
# means a missing optional dependency (e.g. httpx for sports_api) won't
# crash the entire executor, and startup is faster.

_resolved_cache: dict[str, HandlerFn] = {}


def _resolve_handler(handler_name: str) -> HandlerFn:
    """Resolve a dotted handler name to a callable, caching the result."""
    if handler_name in _resolved_cache:
        return _resolved_cache[handler_name]
    # Built-in deterministic handlers are pre-populated
    if handler_name in _BUILTIN_HANDLERS:
        return _BUILTIN_HANDLERS[handler_name]
    # Lazy-load from registry-driven handler map
    spec = _get_skill_handler_map().get(handler_name)
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


_BUILTIN_HANDLERS: dict[str, HandlerFn] = {
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
#
# Handler resolution data now lives in function_registry.json alongside
# the capability definitions.  ``_get_skill_handler_map()`` reads the
# ``module_path`` and ``entry_point`` fields from each implementation and
# caches the result so the import-map is built once per process.  Adding
# a new skill only requires a registry entry — no executor.py edit.

_skill_handler_map_cache: dict[str, tuple[str, str]] | None = None


def _get_skill_handler_map() -> dict[str, tuple[str, str]]:
    """Return the lazily-built skill handler map from the registry."""
    global _skill_handler_map_cache  # noqa: PLW0603
    if _skill_handler_map_cache is None:
        from lokidoki.orchestrator.registry.loader import build_handler_map
        _skill_handler_map_cache = build_handler_map()
    return _skill_handler_map_cache


def register_handler(name: str, handler: HandlerFn) -> None:
    """Register or replace a handler at runtime (used by tests)."""
    _resolved_cache[name] = handler


def list_handlers() -> tuple[str, ...]:
    all_names = set(_BUILTIN_HANDLERS) | set(_get_skill_handler_map()) | set(_resolved_cache)
    return tuple(sorted(all_names))


__all__ = [
    "ExecutionResult",
    "execute_chunk",
    "execute_chunk_async",
    "list_handlers",
    "register_handler",
    "_get_skill_handler_map",
]
