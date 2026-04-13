"""Capability execution for the pipeline.

Each handler is dispatched through :func:`run_handler`, which adds a
per-call timeout and a configurable retry budget. The executor never
raises into the pipeline — failures are captured on
:class:`ExecutionResult` so the combiner / LLM fallback can decide
how to surface them.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from typing import Any

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.core.types import (
    ExecutionResult,
    ImplementationSelection,
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)
from lokidoki.orchestrator.execution.errors import HandlerError, HandlerTimeout, TransientHandlerError
from lokidoki.orchestrator.execution.executor_handlers import (
    BUILTIN_HANDLERS as _BUILTIN_HANDLERS,
    HandlerFn,
    _echo_handler,
    list_handlers,
    register_handler,
    resolve_handler as _resolve_handler,
    get_skill_handler_map as _get_skill_handler_map,
)

log = logging.getLogger("lokidoki.orchestrator.executor")


def execute_chunk(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> ExecutionResult:
    """Synchronous capability execution path used by tests / fast paths."""
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
    """Async capability execution path used by the main pipeline."""
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
        "user_name": (context or {}).get("user_name", "User"),
        "current_time": (context or {}).get("current_time"),
        "current_iso_time": (context or {}).get("current_iso_time"),
        "conversation_topic": (context or {}).get("conversation_topic", ""),
        "mechanism": "asynchronous_skill",
    }


def _build_payload_sync(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> dict[str, Any]:
    """Sync version for internal/test use (no injection support)."""
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
                raw = asyncio.run(raw)  # pragma: no cover
            text, blob = _normalize_handler_result(raw)
            return text, blob, attempts, None
        except TransientHandlerError as exc:
            last_error = str(exc)
            time.sleep(CONFIG.handler_retry_backoff_s)
        except HandlerError as exc:
            return "", {}, attempts, str(exc)
        except Exception as exc:  # noqa: BLE001
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
                _invoke(handler, payload), timeout=effective_timeout,
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
        except Exception as exc:  # noqa: BLE001
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
        return text, _ensure_standard_fields(raw)
    if isinstance(raw, str):
        return raw.strip(), _ensure_standard_fields({"output_text": raw})
    text = str(raw)
    return text, _ensure_standard_fields({"output_text": text})


def _empty_result_blob() -> dict[str, Any]:
    return {
        "output_text": "", "success": True, "error_kind": "none",
        "mechanism_used": "", "data": None, "sources": [],
    }


def _ensure_standard_fields(blob: dict[str, Any]) -> dict[str, Any]:
    blob.setdefault("success", True)
    blob.setdefault("error_kind", "none")
    blob.setdefault("mechanism_used", "")
    blob.setdefault("data", None)
    blob.setdefault("sources", [])
    return blob


__all__ = [
    "ExecutionResult",
    "execute_chunk",
    "execute_chunk_async",
    "list_handlers",
    "register_handler",
    "_get_skill_handler_map",
]
