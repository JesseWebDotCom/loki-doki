"""Async decomposer client — fast Qwen call for routing signals.

Calls the same OpenAI-compatible endpoint as the synthesis path but
with a minimal routing-only prompt and a tight timeout. On failure
(unreachable endpoint, parse error, timeout, or LLM disabled in tests),
returns a fallback :class:`RouteDecomposition` with ``source`` tagging
the failure mode — callers can still proceed with MiniLM-only routing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Optional

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.decomposer.cache import get_cached, put_cached
from lokidoki.orchestrator.decomposer.prompt import build_routing_prompt
from lokidoki.orchestrator.decomposer.types import (
    CAPABILITY_NEEDS,
    RouteDecomposition,
)

log = logging.getLogger("lokidoki.orchestrator.decomposer")

# Hard ceiling on decomposer wall-clock. If the fast model doesn't
# respond in this time the router falls back to MiniLM-only. 1500ms
# covers the p95 of the largest fast model across profiles (Qwen3-8B
# on mac/linux/windows) for the routing prompt's ~80-token JSON
# output; pi_hailo's Qwen3-1.7B finishes well under this ceiling.
DECOMPOSE_TIMEOUT_S: float = 1.5

# Cap output tokens tight — a valid routing JSON is ~80 tokens. Allowing
# more just lets a broken model babble past the closing brace and blow
# the budget.
MAX_OUTPUT_TOKENS: int = 150


async def decompose_for_routing(
    raw_text: str,
    *,
    recent_context: str = "",
    timeout_s: float = DECOMPOSE_TIMEOUT_S,
) -> RouteDecomposition:
    """Extract routing signals from ``raw_text`` via the fast LLM.

    Returns a :class:`RouteDecomposition` with ``source="llm"`` on
    success. Any error (timeout, unreachable endpoint, malformed JSON,
    disabled in tests) produces a fallback result with ``capability_need="none"``
    and ``source`` tagging the failure — routing logic then falls back
    to MiniLM-only scoring.
    """
    started = time.perf_counter()

    if not CONFIG.llm_enabled:
        return _fallback("disabled", started, resolved_query=raw_text)

    if not raw_text or not raw_text.strip():
        return _fallback("empty", started)

    # Cache probe BEFORE the LLM call — repeat turns (retries,
    # echoes, follow-ups) short-circuit to microseconds. Only
    # authoritative prior results get stored, so a cache hit is
    # never a stale failure surfacing as a fake signal.
    cached = get_cached(raw_text, recent_context)
    if cached is not None:
        latency_ms = (time.perf_counter() - started) * 1000
        log.debug("decomposer cache hit: need=%s", cached.capability_need)
        # Return a copy with updated latency so observability sees
        # that this turn was cached (source stays "llm" to preserve
        # authoritativeness — callers treat it identically).
        return RouteDecomposition(
            capability_need=cached.capability_need,
            archive_hint=cached.archive_hint,
            resolved_query=cached.resolved_query,
            source="llm",
            latency_ms=round(latency_ms, 2),
        )

    try:
        text = await asyncio.wait_for(
            _call_fast_llm(raw_text, recent_context),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        log.warning("decomposer timeout after %.0fms", timeout_s * 1000)
        return _fallback("timeout", started, resolved_query=raw_text)
    except Exception as exc:  # noqa: BLE001 — LLM backend may raise any transport error
        log.warning("decomposer LLM error: %s", exc)
        return _fallback("error", started, resolved_query=raw_text)

    parsed = _parse_json(text)
    if parsed is None:
        log.warning("decomposer returned unparseable output: %r", text[:120])
        return _fallback("parse_error", started, resolved_query=raw_text)

    capability_need = _normalize_capability_need(parsed.get("capability_need"))
    archive_hint = (parsed.get("archive_hint") or "").strip().lower()
    resolved_query = (parsed.get("resolved_query") or "").strip() or raw_text

    latency_ms = (time.perf_counter() - started) * 1000
    log.debug(
        "decomposer: need=%s hint=%s latency=%.0fms",
        capability_need, archive_hint, latency_ms,
    )
    result = RouteDecomposition(
        capability_need=capability_need,
        archive_hint=archive_hint,
        resolved_query=resolved_query,
        source="llm",
        latency_ms=round(latency_ms, 1),
    )
    put_cached(raw_text, recent_context, result)
    return result


async def _call_fast_llm(raw_text: str, recent_context: str) -> str:
    """Invoke the fast model with the routing prompt. Returns raw text."""
    from lokidoki.core.providers.client import _extract_full_text

    client = _get_shared_client()
    prompt = build_routing_prompt(raw_text, recent_context)
    body = await client.chat(  # type: ignore[attr-defined]
        model=CONFIG.llm_model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=MAX_OUTPUT_TOKENS,
        temperature=0.0,
    )
    return _extract_full_text(body)


# Match the first balanced ``{…}`` block in the response. Tolerates the
# model wrapping its output in prose, markdown, or ```json fences.
_JSON_OBJECT_RE = re.compile(r"\{[^{}]*\}", re.DOTALL)


def _parse_json(text: str) -> Optional[dict]:
    """Extract + parse the first JSON object in ``text``. ``None`` on failure."""
    if not text:
        return None
    candidates = _JSON_OBJECT_RE.findall(text)
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    # Fallback: whole-string parse (handles clean outputs without prose).
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        return None


def _normalize_capability_need(value: object) -> str:
    """Coerce the model's capability_need into a valid enum value or ``none``."""
    if not isinstance(value, str):
        return "none"
    lowered = value.strip().lower()
    if lowered in CAPABILITY_NEEDS:
        return lowered
    return "none"


def _fallback(
    source: str,
    started: float,
    *,
    resolved_query: str = "",
) -> RouteDecomposition:
    """Build a no-signal :class:`RouteDecomposition` tagged with the failure mode."""
    latency_ms = (time.perf_counter() - started) * 1000
    return RouteDecomposition(
        capability_need="none",
        archive_hint="",
        resolved_query=resolved_query,
        source=source,
        latency_ms=round(latency_ms, 1),
    )


# Reuse the synthesis layer's HTTPProvider singleton so the decomposer
# doesn't open a second httpx connection pool to the same endpoint.
def _get_shared_client() -> object:
    from lokidoki.orchestrator.fallbacks.llm_client import _get_client
    return _get_client()
