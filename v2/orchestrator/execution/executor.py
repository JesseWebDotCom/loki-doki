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
from v2.orchestrator.skills import (
    alarms_local as alarms_skill,
    calculator as calculator_skill,
    calendar_local as calendar_skill,
    contacts_local as contacts_skill,
    dictionary as dictionary_skill,
    finance as finance_skill,
    fitness as fitness_skill,
    food as food_skill,
    health as health_skill,
    holidays as holidays_skill,
    jokes as jokes_skill,
    knowledge as knowledge_skill,
    llm_skills,
    markets as markets_skill,
    music as music_skill,
    navigation as navigation_skill,
    news as news_skill,
    notes_local as notes_skill,
    people_facts as people_facts_skill,
    recipes as recipes_skill,
    shopping_local as shopping_skill,
    showtimes as showtimes_skill,
    smarthome as smarthome_skill,
    sports_api as sports_api_skill,
    sports_search as sports_skill,
    streaming_local as streaming_skill,
    travel as travel_skill,
    travel_local as travel_local_skill,
    time_until as time_until_skill,
    time_in_location as time_in_location_skill,
    translate as translate_skill,
    tv_show as tv_show_skill,
    units as units_skill,
    weather as weather_skill,
)

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


# ---- handler registry ------------------------------------------------------
#
# Every v2 capability dispatches into a real adapter module under
# ``v2/orchestrator/skills/*``. Adapters either wrap a v1 LokiDoki skill
# (inheriting its fallback chain and offline caches) or implement an
# offline-first mechanism chain backed by a curated KB and a persistent
# JSON store under ``v2/data/``. Generative capabilities call
# ``llm_skills`` which talks to Ollama when ``CONFIG.gemma_enabled`` is
# True and degrades to deterministic stubs otherwise. ``SKILL_STUBS.md``
# tracks the remaining LLM-fallback stubs and any cross-cutting work.

_HANDLER_REGISTRY: dict[str, HandlerFn] = {
    # ---- conversation / utility (built-in deterministic) -----------------
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
    # ---- v1-backed adapters ----------------------------------------------
    "device.calendar.create": calendar_skill.create_event,
    "device.calendar.get": calendar_skill.get_events,
    "device.calendar.update": calendar_skill.update_event,
    "device.calendar.delete": calendar_skill.delete_event,
    "device.alarm.set": alarms_skill.set_alarm,
    "device.timer.set": alarms_skill.set_timer,
    "device.reminder.set": alarms_skill.set_reminder,
    "device.alarm.cancel": alarms_skill.cancel_alarm,
    "device.alarm.list": alarms_skill.list_alarms,
    "device.contacts.search": contacts_skill.search_contacts,
    "device.messages.read": contacts_skill.read_messages,
    "device.emails.read": contacts_skill.read_emails,
    "device.phone.call": contacts_skill.make_call,
    "device.notes.create": notes_skill.create_note,
    "device.notes.append_list": notes_skill.append_to_list,
    "device.notes.read_list": notes_skill.read_list,
    "device.notes.search": notes_skill.search_notes,
    "device.music.play": music_skill.play_music,
    "device.music.control": music_skill.control_playback,
    "device.music.now_playing": music_skill.get_now_playing,
    "device.music.volume": music_skill.set_volume,
    "skills.music.lookup_track": music_skill.lookup_track,
    "device.fitness.log": fitness_skill.log_workout,
    "device.fitness.summary": fitness_skill.get_fitness_summary,
    "skills.navigation.directions": navigation_skill.get_directions,
    "skills.navigation.eta": navigation_skill.get_eta,
    "skills.navigation.nearby": navigation_skill.find_nearby,
    "skills.navigation.transit": travel_local_skill.get_transit,
    "skills.media.streaming": streaming_skill.get_streaming,
    "skills.travel.flights.search": travel_local_skill.search_flights,
    "skills.travel.flight_status": travel_skill.get_flight_status,
    "skills.travel.hotels.search": travel_local_skill.search_hotels,
    "skills.travel.visa": travel_local_skill.get_visa_info,
    "skills.health.symptom": health_skill.look_up_symptom,
    "skills.health.medication": health_skill.check_medication,
    "skills.people.fact": people_facts_skill.lookup_fact,
    "skills.shopping.find_products": shopping_skill.find_products,
    "skills.finance.stock_price": markets_skill.get_stock_price,
    "skills.finance.stock_info": markets_skill.get_stock_info,
    "skills.sports.score": sports_api_skill.get_score,
    "skills.sports.standings": sports_api_skill.get_standings,
    "skills.sports.schedule": sports_api_skill.get_schedule,
    "skills.sports.player_stats": sports_skill.get_player_stats,
    "skills.food.nutrition": food_skill.get_nutrition,
    "skills.food.substitute": food_skill.substitute_ingredient,
    "skills.food.order": food_skill.order_food,
    "core.units.convert": units_skill.handle,
    "core.calculator.evaluate": calculator_skill.handle,
    "core.calculator.tip": calculator_skill.calculate_tip,
    "skills.weather.forecast": weather_skill.handle,
    "core.knowledge.lookup": knowledge_skill.handle,
    "skills.movies.showtimes": showtimes_skill.handle,
    "skills.home_assistant.toggle": smarthome_skill.control_device,
    "skills.home_assistant.state": smarthome_skill.get_device_state,
    "skills.sensors.indoor_temperature": smarthome_skill.get_indoor_temperature,
    "skills.presence.detect": smarthome_skill.detect_presence,
    "skills.home_assistant.scene": smarthome_skill.set_scene,
    "skills.dictionary.lookup": dictionary_skill.handle,
    "skills.news.google_rss": news_skill.handle,
    "skills.news.briefing": news_skill.get_briefing,
    "skills.news.search": news_skill.search_news,
    "skills.recipes.themealdb": recipes_skill.handle,
    "skills.jokes.icanhazdadjoke": jokes_skill.handle,
    "skills.tv.tvmaze": tv_show_skill.handle,
    "skills.tv.schedule": tv_show_skill.get_schedule,
    "core.time.location": time_in_location_skill.handle,
    "core.time.until": time_until_skill.handle,
    "skills.holidays.lookup": holidays_skill.get_holiday,
    "skills.holidays.list": holidays_skill.list_holidays,
    "skills.finance.convert_currency": finance_skill.convert_currency,
    "skills.finance.exchange_rate": finance_skill.get_exchange_rate,
    "skills.writing.translate": translate_skill.handle,
    # ---- LLM-backed (Ollama with stub fallback) --------------------------
    "skills.writing.email": llm_skills.generate_email,
    "skills.code.assistant": llm_skills.code_assistance,
    "skills.writing.summarize": llm_skills.summarize_text,
    "skills.planning.create_plan": llm_skills.create_plan,
    "skills.decision.weigh_options": llm_skills.weigh_options,
    "skills.support.empathy": llm_skills.emotional_support,
    # ---- remaining stubs (tracked in SKILL_STUBS.md) ---------------------
    "skills.messaging.send_text": contacts_skill.send_text_message,
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
