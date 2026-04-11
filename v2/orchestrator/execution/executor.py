"""Capability execution for the v2 prototype.

Each handler is dispatched through :func:`run_handler`, which adds a
per-call timeout and a configurable retry budget. The executor never
raises into the pipeline — failures are captured on
:class:`ExecutionResult` so the combiner / Gemma fallback can decide
how to surface them.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from datetime import datetime
from typing import Any, Awaitable, Callable

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.core.types import (
    ExecutionResult,
    ImplementationSelection,
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)
from v2.orchestrator.execution.errors import HandlerError, HandlerTimeout, TransientHandlerError

log = logging.getLogger("v2.executor")

HandlerFn = Callable[[dict[str, Any]], Any | Awaitable[Any]]


def execute_chunk(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> ExecutionResult:
    """Synchronous capability execution path used by tests / fast paths."""
    handler = _resolve_handler(implementation.handler_name)
    payload = _build_payload(chunk, route, resolution)
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
) -> ExecutionResult:
    """Async capability execution path used by the main pipeline."""
    handler = _resolve_handler(implementation.handler_name)
    payload = _build_payload(chunk, route, resolution)
    output_text, raw_result, attempts, error = await _run_with_retries(handler, payload)
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


def _build_payload(
    chunk: RequestChunk,
    route: RouteMatch,
    resolution: ResolutionResult,
) -> dict[str, Any]:
    return {
        "chunk_text": chunk.text,
        "capability": route.capability,
        "resolved_target": resolution.resolved_target,
        "params": dict(resolution.params),
        "context_value": resolution.context_value,
        "candidate_values": list(resolution.candidate_values),
        "unresolved": list(resolution.unresolved),
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
            log.exception("v2 handler %s raised", handler)
            return "", {}, attempts, str(exc)
    return "", {}, attempts, last_error or "exhausted retries"


async def _run_with_retries(
    handler: HandlerFn,
    payload: dict[str, Any],
) -> tuple[str, dict[str, Any], int, str | None]:
    last_error: str | None = None
    attempts = 0
    for attempt in range(CONFIG.handler_retries + 1):
        attempts = attempt + 1
        try:
            raw = await asyncio.wait_for(
                _invoke(handler, payload),
                timeout=CONFIG.handler_timeout_s,
            )
            text, blob = _normalize_handler_result(raw)
            return text, blob, attempts, None
        except asyncio.TimeoutError:
            last_error = f"handler timed out after {CONFIG.handler_timeout_s}s"
            log.warning("v2 handler timeout: %s", handler)
        except TransientHandlerError as exc:
            last_error = str(exc)
        except HandlerError as exc:
            return "", {}, attempts, str(exc)
        except Exception as exc:  # noqa: BLE001 - handlers are untrusted
            log.exception("v2 handler %s raised", handler)
            return "", {}, attempts, str(exc)
        await asyncio.sleep(CONFIG.handler_retry_backoff_s)
    return "", {}, attempts, last_error or "exhausted retries"


async def _invoke(handler: HandlerFn, payload: dict[str, Any]) -> Any:
    if inspect.iscoroutinefunction(handler):
        return await handler(payload)
    return await asyncio.to_thread(handler, payload)


def _normalize_handler_result(raw: Any) -> tuple[str, dict[str, Any]]:
    if raw is None:
        return "", {}
    if isinstance(raw, dict):
        text = str(raw.get("output_text") or raw.get("text") or "").strip()
        return text, raw
    if isinstance(raw, str):
        return raw.strip(), {"output_text": raw}
    text = str(raw)
    return text, {"output_text": text}


def _resolve_handler(handler_name: str) -> HandlerFn:
    return _HANDLER_REGISTRY.get(handler_name, _echo_handler)


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


def _control_device_handler(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    name = params.get("matched_phrase") or payload.get("resolved_target") or "device"
    return {"output_text": f"Toggled {name}."}


def _send_text_handler(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    name = params.get("person_name") or payload.get("resolved_target") or "your contact"
    return {"output_text": f"Texting {name} now."}


def _echo_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": str(payload.get("chunk_text") or "")}


_HANDLER_REGISTRY: dict[str, HandlerFn] = {
    "core.greetings.reply": _greeting_handler,
    "core.acknowledgments.reply": _ack_handler,
    "core.dictionary.spell": _spell_handler,
    "core.dictionary.spell_fallback": _spell_handler,
    "core.time.get_local_time": _time_handler,
    "core.time.get_local_time_backup": _time_handler,
    "core.date.get_local_date": _date_handler,
    "context.media.recall_recent": _recall_media_handler,
    "skills.home_assistant.toggle": _control_device_handler,
    "skills.messaging.send_text": _send_text_handler,
    "fallback.direct_chat": _echo_handler,
}


def register_handler(name: str, handler: HandlerFn) -> None:
    """Register or replace a handler at runtime (used by tests)."""
    _HANDLER_REGISTRY[name] = handler


def list_handlers() -> tuple[str, ...]:
    return tuple(sorted(_HANDLER_REGISTRY.keys()))


__all__ = [
    "ExecutionResult",
    "execute_chunk",
    "execute_chunk_async",
    "list_handlers",
    "register_handler",
]
