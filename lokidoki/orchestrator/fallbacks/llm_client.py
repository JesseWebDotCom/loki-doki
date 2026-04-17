"""LLM client for the synthesis fallback path.

The original ``InferenceClient`` speaks Ollama's ``/api/generate`` wire
format, but all three shipped engines (mlx-lm, llama-server,
hailo-ollama) expose ``/v1/chat/completions`` (OpenAI compat). Posting
to the Ollama endpoint on an MLX server silently 404'd and the
``try / except`` in ``llm_synthesize_async`` swallowed the error,
returning the canned "I don't have a built-in answer" stub for every
``direct_chat`` message.

Switched to :class:`HTTPProvider` from the providers package, which
calls ``/v1/chat/completions`` and works on all profiles.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Callable, Optional

from lokidoki.orchestrator.core.config import CONFIG

log = logging.getLogger("lokidoki.orchestrator.llm")

ProviderFactory = Callable[[], object]

_factory: Optional[ProviderFactory] = None
_cached_client: object | None = None


def set_inference_client_factory(factory: ProviderFactory | None) -> None:
    """Override the provider factory (used by tests)."""
    global _factory, _cached_client
    _factory = factory
    _cached_client = None


def _get_client() -> object:
    global _cached_client
    if _cached_client is not None:
        return _cached_client
    if _factory is not None:
        _cached_client = _factory()
        return _cached_client

    from lokidoki.core.providers.client import HTTPProvider
    from lokidoki.core.providers.spec import ProviderSpec

    spec = ProviderSpec(
        name="pipeline_synth",
        endpoint=CONFIG.llm_endpoint,
        model_fast=CONFIG.llm_model,
        model_thinking=CONFIG.llm_model,
    )
    _cached_client = HTTPProvider(spec)
    return _cached_client


async def call_llm(
    prompt: str,
    *,
    on_token: "Optional[Callable[[str], None]]" = None,
) -> str:
    """Send a rendered prompt to the local LLM via OpenAI-compatible API.

    Returns the raw response text. When ``on_token`` is provided, streams
    the response and calls the callback with each text delta so the SSE
    layer can push partial updates to the frontend in real time.

    If the model hits the token cap (``finish_reason="length"``), retries
    once with a doubled budget (non-streaming, since the retry is rare).
    Raises ``ProviderError`` on failure; the ``llm_fallback`` layer
    wraps the call in fallback logic.
    """
    client = _get_client()

    log.debug(
        "calling LLM: model=%s url=%s prompt_chars=%d",
        CONFIG.llm_model,
        CONFIG.llm_endpoint,
        len(prompt),
    )

    from lokidoki.core.providers.client import _extract_finish_reason, _extract_full_text

    budget = CONFIG.llm_num_predict

    # ── Streaming path: push tokens to frontend as they arrive ──
    if on_token is not None and hasattr(client, "chat_stream"):
        parts: list[str] = []
        finish = ""
        async for chunk in client.chat_stream(  # type: ignore[attr-defined]
            model=CONFIG.llm_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=budget,
            temperature=CONFIG.llm_temperature,
        ):
            if chunk.delta:
                parts.append(chunk.delta)
                on_token(chunk.delta)
            if chunk.done and chunk.raw:
                choice = (chunk.raw.get("choices") or [{}])[0]
                finish = choice.get("finish_reason") or ""
        text = "".join(parts)
        if finish == "length" and text:
            log.warning(
                "LLM response truncated at %d tokens — retrying (non-streaming) with %d",
                budget, budget * 2,
            )
            body = await client.chat(  # type: ignore[attr-defined]
                model=CONFIG.llm_model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=budget * 2,
                temperature=CONFIG.llm_temperature,
            )
            text = _extract_full_text(body)
        return text

    # ── Non-streaming path (tests / stub) ──
    body = await client.chat(  # type: ignore[attr-defined]
        model=CONFIG.llm_model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=budget,
        temperature=CONFIG.llm_temperature,
    )
    text = _extract_full_text(body)
    finish = _extract_finish_reason(body)

    if finish == "length" and text:
        log.warning(
            "LLM response truncated at %d tokens — retrying with %d",
            budget, budget * 2,
        )
        body = await client.chat(  # type: ignore[attr-defined]
            model=CONFIG.llm_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=budget * 2,
            temperature=CONFIG.llm_temperature,
        )
        text = _extract_full_text(body)
        finish = _extract_finish_reason(body)
        if finish == "length":
            log.warning("LLM response still truncated after retry — returning as-is")

    return text


async def close_client() -> None:
    """Release the cached provider (used at shutdown / between tests)."""
    global _cached_client
    if _cached_client is None:
        return
    closer = getattr(_cached_client, "close", None)
    if closer is not None:
        try:
            result = closer()
            if hasattr(result, "__await__"):
                await result  # type: ignore[func-returns-value]
        except Exception:  # noqa: BLE001
            log.exception("error closing LLM client")
    _cached_client = None
