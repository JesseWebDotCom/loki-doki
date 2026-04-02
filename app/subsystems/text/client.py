"""Shared HTTP client helpers for text-chat providers."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Optional, Union
import urllib.error
import urllib.request

from app.providers.types import ProviderSpec


class ProviderRequestError(RuntimeError):
    """Raised when a provider request cannot be completed."""


def _chat_url(provider: ProviderSpec) -> str:
    """Return the chat endpoint for an Ollama-compatible provider."""
    if not provider.endpoint:
        raise ProviderRequestError(f"Provider {provider.name} has no configured endpoint.")
    return f"{provider.endpoint.rstrip('/')}/api/chat"


def _parse_response(raw_body: bytes) -> str:
    """Extract message content from an Ollama-compatible response."""
    payload = json.loads(raw_body.decode("utf-8"))
    message = payload.get("message", {})
    content = message.get("content", "").strip()
    if not content:
        raise ProviderRequestError("Provider returned an empty chat response.")
    return content


def _parse_stream_line(raw_line: bytes) -> str:
    """Extract one incremental content chunk from a provider stream line."""
    payload = json.loads(raw_line.decode("utf-8"))
    message = payload.get("message", {})
    return str(message.get("content", ""))


def chat_completion(
    provider: ProviderSpec,
    messages: list[dict[str, str]],
    options: Optional[dict[str, Union[int, float]]] = None,
    timeout: float = 60.0,
) -> str:
    """Send a non-streaming chat request to the selected provider."""
    request = _chat_request_with_options(provider, messages, stream=False, options=options)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _parse_response(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip() or str(exc)
        raise ProviderRequestError(f"{provider.backend} request failed: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ProviderRequestError(f"{provider.backend} is unavailable at {provider.endpoint}.") from exc
    except json.JSONDecodeError as exc:
        raise ProviderRequestError("Provider returned invalid JSON.") from exc


def stream_chat_completion(
    provider: ProviderSpec,
    messages: list[dict[str, str]],
    options: Optional[dict[str, Union[int, float]]] = None,
    timeout: float = 60.0,
) -> Iterator[str]:
    """Yield text chunks from a streaming provider response."""
    request = _chat_request_with_options(provider, messages, stream=True, options=options)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            for raw_line in response:
                line = raw_line.strip()
                if not line:
                    continue
                chunk = _parse_stream_line(line)
                if chunk:
                    yield chunk
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip() or str(exc)
        raise ProviderRequestError(f"{provider.backend} request failed: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ProviderRequestError(f"{provider.backend} is unavailable at {provider.endpoint}.") from exc
    except json.JSONDecodeError as exc:
        raise ProviderRequestError("Provider returned invalid JSON.") from exc


def _chat_request_with_options(
    provider: ProviderSpec,
    messages: list[dict[str, str]],
    stream: bool,
    options: Optional[dict[str, Union[int, float]]],
) -> urllib.request.Request:
    """Build a provider request including optional generation settings."""
    payload: dict[str, object] = {
        "model": provider.model,
        "messages": messages,
        "stream": stream,
    }
    if options:
        payload["options"] = options
    body = json.dumps(payload).encode("utf-8")
    return urllib.request.Request(
        _chat_url(provider),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
