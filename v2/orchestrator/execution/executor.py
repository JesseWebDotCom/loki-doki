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


def _convert_units_handler(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic unit-conversion fallback for the routed (non-fast-lane) path.

    The fast lane already handles the trivial cases. This handler exists so a
    routed ``convert_units`` chunk still resolves cleanly when the fast lane is
    bypassed (e.g. inside a compound utterance) — it re-uses the same fast-lane
    matcher against the chunk text.
    """
    from v2.orchestrator.pipeline.fast_lane import _match_unit_conversion, _normalize

    chunk_text = str(payload.get("chunk_text") or "")
    lemma = _normalize(chunk_text)
    result = _match_unit_conversion(lemma)
    if result is not None and result.matched and result.response_text:
        return {"output_text": result.response_text}
    return {"output_text": "I couldn't parse that conversion."}


def _weather_handler(payload: dict[str, Any]) -> dict[str, Any]:
    """Stub weather provider used by the v2 prototype.

    A real backend would hit a weather API. The prototype returns a
    deterministic forecast string so routing tests can assert on shape.
    """
    return {
        "output_text": "Weather forecast: clear with a high near 72°F.",
        "provider": "stub",
    }


def _showtimes_handler(payload: dict[str, Any]) -> dict[str, Any]:
    """Stub movie-showtimes provider used by the v2 prototype."""
    chunk_text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    title = _extract_showtimes_title(chunk_text)
    return {"output_text": f"Showtimes for {title}: 4:30 PM, 7:00 PM, and 9:45 PM."}


def _extract_showtimes_title(chunk_text: str) -> str:
    """Best-effort title extraction from a showtimes utterance.

    Three strategies, in order:
      1. ``movie times for X (in/at/on ...)?`` — pull X.
      2. ``what time is the X movie playing`` — pull X + "movie".
      3. Fallback: the chunk text itself.
    """
    if not chunk_text:
        return "the requested movie"

    stop_after = (" in ", " at ", " on ", " near ", " for ", " tonight", " tomorrow", " today")

    if " for " in chunk_text:
        tail = chunk_text.split(" for ", 1)[1]
        for marker in stop_after:
            if marker in tail and not marker.startswith(" for"):
                tail = tail.split(marker, 1)[0]
        candidate = tail.strip()
        if candidate:
            return candidate

    for marker in (" movie ", " film "):
        if marker in chunk_text:
            head = chunk_text.split(marker, 1)[0]
            tokens = [
                tok
                for tok in head.split()
                if tok not in {"what", "time", "is", "the", "a", "an", "new", "when", "does", "show", "me"}
            ]
            if tokens:
                return " ".join(tokens) + " movie"

    return "the requested movie"


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


def _knowledge_handler(payload: dict[str, Any]) -> dict[str, Any]:
    """Stub knowledge-query provider.

    Real factual lookup would defer to a retrieval skill or a thinking-mode
    LLM. The prototype returns a marker string that names the topic so
    routing tests can confirm the question reached this capability.
    """
    chunk_text = str(payload.get("chunk_text") or "").strip()
    return {
        "output_text": f"Knowledge query (stub): {chunk_text}",
        "provider": "stub",
    }


def _echo_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {"output_text": str(payload.get("chunk_text") or "")}


# ---- stub skill handlers (see v2/SKILL_STUBS.md) ---------------------------
#
# These handlers exist so the routing layer has a real destination for every
# capability ChatGPT's "Prompt -> Skill Routing Table" identified, but they
# do not yet integrate with a real backend. Each one returns a deterministic
# placeholder string that the regression tests can assert on. The
# v2/SKILL_STUBS.md doc tracks what each stub needs in order to ship.


def _indoor_temperature_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "output_text": "Indoor temperature is currently 68°F (stub).",
        "provider": "stub",
    }


def _detect_presence_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "").lower()
    room = "that room"
    for marker in (" in the ", " in "):
        if marker in chunk_text:
            tail = chunk_text.split(marker, 1)[1].strip(" ?.!")
            if tail:
                room = "the " + tail if not tail.startswith("the ") else tail
                break
    return {
        "output_text": f"I don't see anyone in {room} right now (stub).",
        "provider": "stub",
    }


def _device_state_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    device = "that device"
    for trigger in ("close ", "lock ", "turn ", "is ", "are "):
        if trigger in chunk_text:
            tail = chunk_text.split(trigger, 1)[1].strip()
            tail = tail.lstrip("the ").strip()
            if tail:
                device = "the " + tail.split(" ")[0] if " " in tail else "the " + tail
                # Use up to 3 trailing tokens to keep multi-word device names.
                tokens = tail.split()
                device = "the " + " ".join(tokens[: min(3, len(tokens))])
                break
    return {
        "output_text": f"{device.capitalize()} is currently closed (stub).",
        "provider": "stub",
    }


def _time_in_location_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "").lower().strip(" ?.!")
    city = "that city"
    if " in " in chunk_text:
        tail = chunk_text.split(" in ", 1)[1].strip(" ?.!")
        if tail:
            city = tail
    return {
        "output_text": f"It's currently 9:30 PM in {city.title()} (stub: location-aware time not yet wired up).",
        "provider": "stub",
    }


def _generate_email_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    return {
        "output_text": (
            "Subject: Refund Request\n\n"
            "Dear Sir or Madam,\n\n"
            "I am writing to request a refund for my recent purchase. "
            "[Stub email body — generative model not yet wired up.]\n\n"
            "Sincerely,\nThe User"
        ),
        "request": chunk_text,
        "provider": "stub",
    }


def _code_assistance_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    return {
        "output_text": (
            "```python\n"
            "# Stub code response — generative model not yet wired up.\n"
            "def solve():\n"
            "    pass\n"
            "```"
        ),
        "request": chunk_text,
        "provider": "stub",
    }


def _summarize_text_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "output_text": "Summary (stub): the article's main point in one sentence.",
        "provider": "stub",
    }


def _create_plan_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "output_text": (
            "Plan (stub):\n"
            "  Day 1 — Arrival and orientation\n"
            "  Day 2 — Main activities\n"
            "  Day 3 — Wrap up and departure"
        ),
        "provider": "stub",
    }


def _weigh_options_handler(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "")
    return {
        "output_text": (
            "Both options have merit (stub). Pros and cons would be weighed "
            "against your goals, risk tolerance, and time horizon — generative "
            "reasoning model not yet wired up."
        ),
        "request": chunk_text,
        "provider": "stub",
    }


def _find_products_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "output_text": (
            "Top picks (stub): Option A, Option B, Option C — "
            "real product search backend not yet wired up."
        ),
        "provider": "stub",
    }


def _emotional_support_handler(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "output_text": (
            "I hear you, and that sounds really hard (stub). I'm here if you "
            "want to talk about it more — empathetic LLM not yet wired up."
        ),
        "provider": "stub",
    }


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
    "core.units.convert": _convert_units_handler,
    "skills.weather.forecast": _weather_handler,
    "skills.movies.showtimes": _showtimes_handler,
    "core.people.birthday": _person_birthday_handler,
    "core.knowledge.lookup": _knowledge_handler,
    # ---- ChatGPT-table stub skills (see v2/SKILL_STUBS.md) ---------------
    "skills.sensors.indoor_temperature": _indoor_temperature_handler,
    "skills.presence.detect": _detect_presence_handler,
    "skills.home_assistant.state": _device_state_handler,
    "core.time.location": _time_in_location_handler,
    "skills.writing.email": _generate_email_handler,
    "skills.code.assistant": _code_assistance_handler,
    "skills.writing.summarize": _summarize_text_handler,
    "skills.planning.create_plan": _create_plan_handler,
    "skills.decision.weigh_options": _weigh_options_handler,
    "skills.shopping.find_products": _find_products_handler,
    "skills.support.empathy": _emotional_support_handler,
    # -----------------------------------------------------------------------
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
