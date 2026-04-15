"""OpenAI-compatible chat client + single-shot generate wrapper.

All three ships-in-this-chunk engines (mlx-lm, llama-server,
hailo-ollama) accept ``POST /v1/chat/completions`` and stream SSE. A
non-streaming call returns the full envelope in the body. This client
handles both shapes and offers a ``generate(prompt)`` helper that
wraps a single user message for callers migrating from Ollama's
``/api/generate``.
"""
from __future__ import annotations

import base64
import io
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional, Sequence, Union

import httpx

from .spec import ProviderSpec


VisionImage = Union[bytes, "Any"]  # bytes OR PIL.Image.Image — imported lazily


_log = logging.getLogger(__name__)


class ProviderError(Exception):
    """Raised when the upstream LLM endpoint errors or is unreachable."""


@dataclass(frozen=True)
class ChatChunk:
    """One SSE chunk from a streamed chat completion.

    ``delta`` is the incremental text for this chunk; ``done`` flips to
    True on the terminal ``[DONE]`` sentinel (or when the server emits
    a ``finish_reason``). ``raw`` carries the decoded JSON payload in
    case a caller needs usage / function-call metadata.
    """

    delta: str
    done: bool = False
    raw: Optional[dict] = None


Message = dict[str, str]


class HTTPProvider:
    """Thin async client over an OpenAI-compatible chat endpoint."""

    def __init__(self, spec: ProviderSpec, *, timeout_s: float = 120.0) -> None:
        self.spec = spec
        self._client = httpx.AsyncClient(base_url=spec.endpoint, timeout=timeout_s)

    # ------------------------------------------------------------------
    # non-streaming
    # ------------------------------------------------------------------
    async def chat(
        self,
        model: str,
        messages: Sequence[Message],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        response_format: Optional[dict] = None,
        extra_body: Optional[dict] = None,
    ) -> dict:
        """POST ``/v1/chat/completions`` with ``stream=False`` and return the JSON body."""
        payload = self._chat_payload(
            model=model,
            messages=messages,
            stream=False,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format,
            extra_body=extra_body,
        )
        try:
            resp = await self._client.post("/v1/chat/completions", json=payload)
        except (httpx.ConnectError, ConnectionError, OSError) as exc:
            raise ProviderError(f"LLM endpoint unreachable at {self.spec.endpoint}") from exc
        if resp.status_code != 200:
            raise ProviderError(
                f"LLM endpoint error {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    async def generate(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        response_format: Optional[dict] = None,
        extra_body: Optional[dict] = None,
    ) -> str:
        """Compat shim: wrap ``prompt`` in a user message, return the final text."""
        body = await self.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format,
            extra_body=extra_body,
        )
        return _extract_full_text(body)

    # ------------------------------------------------------------------
    # streaming
    # ------------------------------------------------------------------
    async def chat_stream(
        self,
        model: str,
        messages: Sequence[Message],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        extra_body: Optional[dict] = None,
    ) -> AsyncIterator[ChatChunk]:
        """Stream SSE chunks from ``/v1/chat/completions``."""
        payload = self._chat_payload(
            model=model,
            messages=messages,
            stream=True,
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body=extra_body,
        )
        try:
            async with self._client.stream(
                "POST", "/v1/chat/completions", json=payload
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise ProviderError(
                        f"LLM endpoint error {resp.status_code}: "
                        f"{body[:200].decode(errors='replace')}"
                    )
                async for event in _iter_sse_events(resp.aiter_lines()):
                    if event == "[DONE]":
                        yield ChatChunk(delta="", done=True)
                        return
                    try:
                        decoded = json.loads(event)
                    except json.JSONDecodeError:
                        continue
                    choice = (decoded.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    piece = delta.get("content") or ""
                    finish = choice.get("finish_reason")
                    if piece:
                        yield ChatChunk(delta=piece, done=False, raw=decoded)
                    if finish:
                        yield ChatChunk(delta="", done=True, raw=decoded)
                        return
        except ProviderError:
            raise
        except (httpx.ConnectError, ConnectionError, OSError) as exc:
            raise ProviderError(f"LLM endpoint unreachable at {self.spec.endpoint}") from exc
        except Exception as exc:  # noqa: BLE001 — surface transport failures uniformly
            raise ProviderError(f"LLM stream failed: {exc}") from exc

    async def generate_stream(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        extra_body: Optional[dict] = None,
    ) -> AsyncIterator[str]:
        """Stream only the text deltas for a single user prompt."""
        async for chunk in self.chat_stream(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body=extra_body,
        ):
            if chunk.delta:
                yield chunk.delta

    # ------------------------------------------------------------------
    # vision
    # ------------------------------------------------------------------
    async def vision(
        self,
        model: str,
        images: Sequence[VisionImage],
        prompt: str,
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        extra_body: Optional[dict] = None,
    ) -> dict:
        """POST an OpenAI-style vision chat to the configured vision endpoint.

        ``images`` may be raw ``bytes`` (PNG-encoded) or PIL ``Image``
        objects — PIL is imported lazily so callers that never use
        vision don't pay the import cost. All entries are base64-encoded
        and emitted as ``image_url`` content parts alongside ``prompt``.

        Routes to :attr:`ProviderSpec.vision_endpoint` when set (so
        llama.cpp profiles hit :11435 instead of the text :11434); falls
        back to :attr:`ProviderSpec.endpoint` on engines where the same
        process handles both modalities (MLX).
        """
        if not images:
            raise ValueError("vision() requires at least one image")
        content_parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for img in images:
            content_parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": _image_data_url(img)},
                }
            )
        messages = [{"role": "user", "content": content_parts}]
        payload = self._chat_payload(
            model=model,
            messages=messages,  # type: ignore[arg-type] — mixed-content shape is OpenAI-spec
            stream=False,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=None,
            extra_body=extra_body,
        )
        endpoint = self.spec.vision_endpoint or self.spec.endpoint
        client = self._vision_client(endpoint)
        try:
            resp = await client.post("/v1/chat/completions", json=payload)
        except (httpx.ConnectError, ConnectionError, OSError) as exc:
            raise ProviderError(f"vision endpoint unreachable at {endpoint}") from exc
        finally:
            if client is not self._client:
                await client.aclose()
        if resp.status_code != 200:
            raise ProviderError(
                f"vision endpoint error {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    def _vision_client(self, endpoint: str) -> httpx.AsyncClient:
        """Reuse the text client when endpoints match; otherwise build a short-lived one."""
        if endpoint == self.spec.endpoint:
            return self._client
        return httpx.AsyncClient(base_url=endpoint, timeout=self._client.timeout)

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _chat_payload(
        self,
        *,
        model: str,
        messages: Sequence[Message],
        stream: bool,
        max_tokens: Optional[int],
        temperature: Optional[float],
        response_format: Optional[dict] = None,
        extra_body: Optional[dict] = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "model": model,
            "messages": list(messages),
            "stream": stream,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if temperature is not None:
            payload["temperature"] = temperature
        if response_format is not None:
            payload["response_format"] = response_format
        if extra_body:
            payload.update(extra_body)
        return payload


def _extract_full_text(body: dict) -> str:
    """Pull the concatenated response text from an OpenAI chat body."""
    choices = body.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return message.get("content") or ""


def _image_data_url(img: VisionImage) -> str:
    """Encode ``img`` as a ``data:image/png;base64,…`` URL.

    Accepts raw ``bytes`` (assumed PNG-encoded) or a PIL ``Image`` which
    we serialise to PNG in-memory. PIL is imported lazily so the
    text-only path stays dependency-light.
    """
    if isinstance(img, (bytes, bytearray)):
        data = bytes(img)
    else:
        try:
            from PIL import Image  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover — PIL ships with the app
            raise ProviderError(
                "vision() received a non-bytes image but PIL is not installed"
            ) from exc
        if not isinstance(img, Image.Image):
            raise TypeError(f"vision() image must be bytes or PIL.Image, got {type(img)!r}")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{encoded}"


async def _iter_sse_events(lines: AsyncIterator[str]) -> AsyncIterator[str]:
    """Yield the ``data:`` payloads from an SSE stream as raw strings.

    ``[DONE]`` is passed through so the caller can distinguish the
    terminal sentinel from a regular chunk without a second parse.
    """
    async for line in lines:
        if not line or line.startswith(":"):
            continue
        if line.startswith("data:"):
            yield line[5:].strip()
