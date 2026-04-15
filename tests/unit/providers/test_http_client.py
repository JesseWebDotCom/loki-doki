"""HTTPProvider against a stubbed OpenAI-compat endpoint.

We don't depend on a real llama-server — `httpx.MockTransport` speaks
the wire format directly. The shape we assert is the OpenAI-compat
``/v1/chat/completions`` contract: JSON body for non-stream, SSE
``data: {...}`` lines for stream (terminated by ``data: [DONE]``).
"""
from __future__ import annotations

import json
from typing import Iterator

import httpx
import pytest

from lokidoki.core.providers.client import HTTPProvider, ProviderError
from lokidoki.core.providers.spec import ProviderSpec


def _spec() -> ProviderSpec:
    return ProviderSpec(
        name="llama_cpp_cpu",
        endpoint="http://testserver",
        model_fast="Qwen/Qwen3-4B-GGUF:Q4_K_M",
        model_thinking="Qwen/Qwen3-4B-GGUF:Q4_K_M",
    )


def _install_transport(provider: HTTPProvider, handler) -> None:
    """Swap the httpx client for one backed by MockTransport."""
    transport = httpx.MockTransport(handler)
    provider._client = httpx.AsyncClient(  # noqa: SLF001 — test seam
        base_url=provider.spec.endpoint,
        transport=transport,
    )


@pytest.mark.anyio
async def test_chat_returns_json_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        assert request.url.path == "/v1/chat/completions"
        assert payload["model"] == "Qwen/Qwen3-4B-GGUF:Q4_K_M"
        assert payload["messages"] == [{"role": "user", "content": "hi"}]
        assert payload["stream"] is False
        assert payload["max_tokens"] == 32
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "hello"}}]
            },
        )

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        body = await provider.chat(
            model=_spec().model_fast,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=32,
        )
    finally:
        await provider.close()
    assert body["choices"][0]["message"]["content"] == "hello"


@pytest.mark.anyio
async def test_generate_unpacks_text() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "LokiDoki online"}}]},
        )

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        text = await provider.generate(model=_spec().model_fast, prompt="ping")
    finally:
        await provider.close()
    assert text == "LokiDoki online"


@pytest.mark.anyio
async def test_chat_stream_yields_deltas_then_done() -> None:
    sse_events = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]
    body = ("\n\n".join(sse_events) + "\n\n").encode()

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        assert payload["stream"] is True
        return httpx.Response(
            200, content=body, headers={"content-type": "text/event-stream"}
        )

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        chunks = []
        async for chunk in provider.chat_stream(
            model=_spec().model_fast,
            messages=[{"role": "user", "content": "hi"}],
        ):
            chunks.append(chunk)
    finally:
        await provider.close()

    deltas = [c.delta for c in chunks if c.delta]
    assert deltas == ["Hello", " world", "!"]
    assert chunks[-1].done is True


@pytest.mark.anyio
async def test_generate_stream_yields_only_text() -> None:
    sse = (
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    ).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse, headers={"content-type": "text/event-stream"})

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        pieces = [p async for p in provider.generate_stream(model="x", prompt="y")]
    finally:
        await provider.close()
    assert pieces == ["a", "b"]


@pytest.mark.anyio
async def test_non_200_raises_provider_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        with pytest.raises(ProviderError, match="500"):
            await provider.chat(
                model=_spec().model_fast,
                messages=[{"role": "user", "content": "hi"}],
            )
    finally:
        await provider.close()


@pytest.mark.anyio
async def test_connect_error_raises_provider_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        with pytest.raises(ProviderError, match="unreachable"):
            await provider.chat(
                model=_spec().model_fast,
                messages=[{"role": "user", "content": "hi"}],
            )
    finally:
        await provider.close()


@pytest.mark.anyio
async def test_response_format_passes_through() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["extra"] == "ok"  # extra_body spread into payload
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "{}"}}]},
        )

    provider = HTTPProvider(_spec())
    _install_transport(provider, handler)
    try:
        await provider.chat(
            model=_spec().model_fast,
            messages=[{"role": "user", "content": "hi"}],
            response_format={"type": "json_object"},
            extra_body={"extra": "ok"},
        )
    finally:
        await provider.close()


# quiet unused-import warnings from typing
_ = Iterator
