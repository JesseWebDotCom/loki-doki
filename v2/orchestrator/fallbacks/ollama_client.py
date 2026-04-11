"""Concrete Ollama LLM client for the v2 fallback path.

The v2 prototype is meant to stay isolated from the rest of the
``lokidoki`` codebase, but the existing :class:`InferenceClient` is the
production-quality HTTP wrapper for Ollama and re-implementing it would
just create drift. We import it here as a *consumer*: this module never
modifies anything in ``lokidoki``, it only calls one async method.

The client is constructed lazily so:

* Tests that don't enable LLM never instantiate it (no httpx client
  hanging around the event loop).
* The seam can be replaced with a fake in tests via
  :func:`set_inference_client_factory`.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

from v2.orchestrator.core.config import CONFIG

log = logging.getLogger("v2.orchestrator.llm")

# A factory rather than an instance so tests can swap implementations.
InferenceClientFactory = Callable[[], object]

_factory: Optional[InferenceClientFactory] = None
_cached_client: object | None = None


def set_inference_client_factory(factory: InferenceClientFactory | None) -> None:
    """Override the InferenceClient factory (used by tests)."""
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

    # Default factory: import lokidoki.core.inference lazily so a test
    # that monkeypatches the import path before this module loads still
    # works.
    from lokidoki.core.inference import InferenceClient

    _cached_client = InferenceClient(base_url=CONFIG.llm_ollama_url)
    return _cached_client


async def call_llm(prompt: str) -> str:
    """Send a rendered prompt to the local Ollama LLM model.

    Returns the raw response text. Raises whatever the underlying
    InferenceClient raises (typically ``OllamaError``); the llm_fallback
    layer is responsible for wrapping the call in retry / fallback logic.
    """
    client = _get_client()

    log.debug(
        "calling LLM via Ollama: model=%s url=%s prompt_chars=%d",
        CONFIG.llm_model,
        CONFIG.llm_ollama_url,
        len(prompt),
    )

    # InferenceClient.generate is async; we delegate directly. Synthesis
    # passes ``think=False`` because the gemma family will otherwise
    # burn the entire ``num_predict`` budget on internal thinking tokens.
    # Note: ``think=False`` is honored by gemma but NOT by qwen3 base —
    # for qwen3 we ship the explicit ``-instruct-2507`` variant which
    # has thinking stripped at the model level.
    response: Awaitable[str] = client.generate(  # type: ignore[attr-defined]
        model=CONFIG.llm_model,
        prompt=prompt,
        num_predict=CONFIG.llm_num_predict,
        temperature=CONFIG.llm_temperature,
        think=False,
    )
    return await response


async def close_client() -> None:
    """Release the cached InferenceClient (used at shutdown / between tests)."""
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
            log.exception("error closing v2 LLM client")
    _cached_client = None
