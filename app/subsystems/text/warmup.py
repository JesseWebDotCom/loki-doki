"""Background warm-up helpers for text-chat providers."""

from __future__ import annotations

import logging
import threading
import time
from typing import Union

from app import db
from app.config import AppConfig
from app.providers.types import ProviderSpec
from app.runtime import runtime_context
from app.subsystems.text.client import ProviderRequestError, chat_completion


LOGGER = logging.getLogger(__name__)
WARMUP_OPTIONS: dict[str, Union[int, float]] = {"temperature": 0.0, "num_predict": 8}
WARMUP_MESSAGE = [{"role": "user", "content": "Reply with ok."}]


def start_text_model_warmup(app_config: AppConfig) -> None:
    """Warm text providers in a background thread without blocking startup."""
    worker = threading.Thread(
        target=warm_text_models,
        args=(app_config,),
        name="lokidoki-text-warmup",
        daemon=True,
    )
    worker.start()


def warm_text_models(app_config: AppConfig) -> None:
    """Prime the active text providers so the first user prompt is faster."""
    connection = db.connect(app_config.database_path)
    try:
        context = runtime_context(connection, app_config)
    finally:
        connection.close()
    warmed: set[tuple[str, str]] = set()
    for key in ("llm_fast", "llm_thinking"):
        provider = context["providers"].get(key)
        if provider is None or not provider.endpoint:
            continue
        dedupe_key = (provider.endpoint, provider.model)
        if dedupe_key in warmed:
            continue
        warmed.add(dedupe_key)
        _warm_provider(provider, context["settings"]["profile"])


def _warm_provider(provider: ProviderSpec, profile: str) -> None:
    """Send a tiny request to load the model into the active runtime."""
    start = time.perf_counter()
    try:
        chat_completion(provider, WARMUP_MESSAGE, options=WARMUP_OPTIONS, timeout=30.0)
    except ProviderRequestError as exc:
        LOGGER.warning(
            "Text model warm-up failed for %s on %s via %s: %s",
            provider.model,
            profile,
            provider.backend,
            exc,
        )
        return
    duration = time.perf_counter() - start
    LOGGER.info(
        "Warmed text model %s on %s via %s in %.3fs.",
        provider.model,
        profile,
        provider.backend,
        duration,
    )
