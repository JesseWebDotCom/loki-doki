"""Capability execution for the v2 prototype.

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
    *,
    budget_ms: int | None = None,
) -> ExecutionResult:
    """Async capability execution path used by the main pipeline.

    ``budget_ms`` overrides the default handler timeout when the registry
    specifies a per-capability ``max_chunk_budget_ms``.
    """
    handler = _resolve_handler(implementation.handler_name)
    payload = _build_payload(chunk, route, resolution)
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
    # Lazy-load from _SKILL_HANDLER_MAP
    spec = _SKILL_HANDLER_MAP.get(handler_name)
    if spec is None:
        return _echo_handler
    module_path, attr_name = spec
    try:
        module = importlib.import_module(module_path)
        handler = getattr(module, attr_name)
        _resolved_cache[handler_name] = handler
        return handler
    except (ImportError, AttributeError) as exc:
        log.warning("v2 handler %s unavailable: %s", handler_name, exc)
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

# ---- lazy-loaded skill handler map ------------------------------------------
#
# Maps handler_name -> (module_path, attribute_name). Modules are imported
# on first call via importlib, not at executor load time.

_SKILL_HANDLER_MAP: dict[str, tuple[str, str]] = {
    # ---- device / local adapters --------------------------------------------
    "device.calendar.create": ("v2.orchestrator.skills.calendar_local", "create_event"),
    "device.calendar.get": ("v2.orchestrator.skills.calendar_local", "get_events"),
    "device.calendar.update": ("v2.orchestrator.skills.calendar_local", "update_event"),
    "device.calendar.delete": ("v2.orchestrator.skills.calendar_local", "delete_event"),
    "device.alarm.set": ("v2.orchestrator.skills.alarms_local", "set_alarm"),
    "device.timer.set": ("v2.orchestrator.skills.alarms_local", "set_timer"),
    "device.reminder.set": ("v2.orchestrator.skills.alarms_local", "set_reminder"),
    "device.alarm.cancel": ("v2.orchestrator.skills.alarms_local", "cancel_alarm"),
    "device.alarm.list": ("v2.orchestrator.skills.alarms_local", "list_alarms"),
    "device.contacts.search": ("v2.orchestrator.skills.contacts_local", "search_contacts"),
    "device.messages.read": ("v2.orchestrator.skills.contacts_local", "read_messages"),
    "device.emails.read": ("v2.orchestrator.skills.contacts_local", "read_emails"),
    "device.phone.call": ("v2.orchestrator.skills.contacts_local", "make_call"),
    "device.notes.create": ("v2.orchestrator.skills.notes_local", "create_note"),
    "device.notes.append_list": ("v2.orchestrator.skills.notes_local", "append_to_list"),
    "device.notes.read_list": ("v2.orchestrator.skills.notes_local", "read_list"),
    "device.notes.search": ("v2.orchestrator.skills.notes_local", "search_notes"),
    "device.music.play": ("v2.orchestrator.skills.music", "play_music"),
    "device.music.control": ("v2.orchestrator.skills.music", "control_playback"),
    "device.music.now_playing": ("v2.orchestrator.skills.music", "get_now_playing"),
    "device.music.volume": ("v2.orchestrator.skills.music", "set_volume"),
    "skills.music.lookup_track": ("v2.orchestrator.skills.music", "lookup_track"),
    "device.fitness.log": ("v2.orchestrator.skills.fitness", "log_workout"),
    "device.fitness.summary": ("v2.orchestrator.skills.fitness", "get_fitness_summary"),
    # ---- navigation / travel ------------------------------------------------
    "skills.navigation.directions": ("v2.orchestrator.skills.navigation", "get_directions"),
    "skills.navigation.eta": ("v2.orchestrator.skills.navigation", "get_eta"),
    "skills.navigation.nearby": ("v2.orchestrator.skills.navigation", "find_nearby"),
    "skills.navigation.transit": ("v2.orchestrator.skills.travel_local", "get_transit"),
    "skills.media.streaming": ("v2.orchestrator.skills.streaming_local", "get_streaming"),
    "skills.travel.flights.search": ("v2.orchestrator.skills.travel_local", "search_flights"),
    "skills.travel.flight_status": ("v2.orchestrator.skills.travel", "get_flight_status"),
    "skills.travel.hotels.search": ("v2.orchestrator.skills.travel_local", "search_hotels"),
    "skills.travel.visa": ("v2.orchestrator.skills.travel_local", "get_visa_info"),
    # ---- health / people / shopping -----------------------------------------
    "skills.health.symptom": ("v2.orchestrator.skills.health", "look_up_symptom"),
    "skills.health.medication": ("v2.orchestrator.skills.health", "check_medication"),
    "skills.people.fact": ("v2.orchestrator.skills.people_facts", "lookup_fact"),
    "skills.shopping.find_products": ("v2.orchestrator.skills.shopping_local", "find_products"),
    # ---- finance / sports ---------------------------------------------------
    "skills.finance.stock_price": ("v2.orchestrator.skills.markets", "get_stock_price"),
    "skills.finance.stock_info": ("v2.orchestrator.skills.markets", "get_stock_info"),
    "skills.sports.score": ("v2.orchestrator.skills.sports_api", "get_score"),
    "skills.sports.standings": ("v2.orchestrator.skills.sports_api", "get_standings"),
    "skills.sports.schedule": ("v2.orchestrator.skills.sports_api", "get_schedule"),
    "skills.sports.player_stats": ("v2.orchestrator.skills.sports_api", "get_player_stats"),
    # ---- food / units / calc ------------------------------------------------
    "skills.food.nutrition": ("v2.orchestrator.skills.food", "get_nutrition"),
    "skills.food.substitute": ("v2.orchestrator.skills.food", "substitute_ingredient"),
    "skills.food.order": ("v2.orchestrator.skills.food", "order_food"),
    "core.units.convert": ("v2.orchestrator.skills.units", "handle"),
    "core.calculator.evaluate": ("v2.orchestrator.skills.calculator", "handle"),
    "core.calculator.tip": ("v2.orchestrator.skills.calculator", "calculate_tip"),
    # ---- weather / knowledge / showtimes ------------------------------------
    "skills.weather.forecast": ("v2.orchestrator.skills.weather", "handle"),
    "core.knowledge.lookup": ("v2.orchestrator.skills.knowledge", "handle"),
    "skills.movies.showtimes": ("v2.orchestrator.skills.showtimes", "handle"),
    # ---- home automation ----------------------------------------------------
    "skills.home_assistant.toggle": ("v2.orchestrator.skills.smarthome", "control_device"),
    "skills.home_assistant.state": ("v2.orchestrator.skills.smarthome", "get_device_state"),
    "skills.sensors.indoor_temperature": ("v2.orchestrator.skills.smarthome", "get_indoor_temperature"),
    "skills.presence.detect": ("v2.orchestrator.skills.smarthome", "detect_presence"),
    "skills.home_assistant.scene": ("v2.orchestrator.skills.smarthome", "set_scene"),
    # ---- info / media -------------------------------------------------------
    "skills.dictionary.lookup": ("v2.orchestrator.skills.dictionary", "handle"),
    "skills.news.google_rss": ("v2.orchestrator.skills.news", "handle"),
    "skills.news.briefing": ("v2.orchestrator.skills.news", "get_briefing"),
    "skills.news.search": ("v2.orchestrator.skills.news", "search_news"),
    "skills.recipes.themealdb": ("v2.orchestrator.skills.recipes", "handle"),
    "skills.jokes.icanhazdadjoke": ("v2.orchestrator.skills.jokes", "handle"),
    "skills.tv.tvmaze": ("v2.orchestrator.skills.tv_show", "handle"),
    "skills.tv.schedule": ("v2.orchestrator.skills.tv_show", "get_schedule"),
    # ---- time / holidays ----------------------------------------------------
    "core.time.location": ("v2.orchestrator.skills.time_in_location", "handle"),
    "core.time.until": ("v2.orchestrator.skills.time_until", "handle"),
    "skills.holidays.lookup": ("v2.orchestrator.skills.holidays", "get_holiday"),
    "skills.holidays.list": ("v2.orchestrator.skills.holidays", "list_holidays"),
    # ---- finance (currency) -------------------------------------------------
    "skills.finance.convert_currency": ("v2.orchestrator.skills.finance", "convert_currency"),
    "skills.finance.exchange_rate": ("v2.orchestrator.skills.finance", "get_exchange_rate"),
    "skills.writing.translate": ("v2.orchestrator.skills.translate", "handle"),
    # ---- LLM-backed (Ollama with stub fallback) -----------------------------
    "skills.writing.email": ("v2.orchestrator.skills.llm_skills", "generate_email"),
    "skills.code.assistant": ("v2.orchestrator.skills.llm_skills", "code_assistance"),
    "skills.writing.summarize": ("v2.orchestrator.skills.llm_skills", "summarize_text"),
    "skills.planning.create_plan": ("v2.orchestrator.skills.llm_skills", "create_plan"),
    "skills.decision.weigh_options": ("v2.orchestrator.skills.llm_skills", "weigh_options"),
    "skills.support.empathy": ("v2.orchestrator.skills.llm_skills", "emotional_support"),
    # ---- remaining stubs ----------------------------------------------------
    "skills.messaging.send_text": ("v2.orchestrator.skills.contacts_local", "send_text_message"),
}


def register_handler(name: str, handler: HandlerFn) -> None:
    """Register or replace a handler at runtime (used by tests)."""
    _resolved_cache[name] = handler


def list_handlers() -> tuple[str, ...]:
    all_names = set(_BUILTIN_HANDLERS) | set(_SKILL_HANDLER_MAP) | set(_resolved_cache)
    return tuple(sorted(all_names))


__all__ = [
    "ExecutionResult",
    "execute_chunk",
    "execute_chunk_async",
    "list_handlers",
    "register_handler",
]
