"""HTTPProvider.vision() — OpenAI vision content-part encoding + routing."""
from __future__ import annotations

import base64
import json

import httpx
import pytest

from lokidoki.core.providers.client import HTTPProvider, ProviderError
from lokidoki.core.providers.spec import ProviderSpec


def _mlx_spec() -> ProviderSpec:
    """MLX shares text + vision on one endpoint."""
    return ProviderSpec(
        name="mlx",
        endpoint="http://text",
        model_fast="mlx-community/Qwen3-8B-4bit",
        model_thinking="mlx-community/Qwen3-14B-4bit",
        vision_model="mlx-community/Qwen2-VL-7B-Instruct-4bit",
        vision_endpoint="http://text",
    )


def _llama_spec() -> ProviderSpec:
    """llama.cpp splits text (:11434) + vision (:11435) into two processes."""
    return ProviderSpec(
        name="llama_cpp_vulkan",
        endpoint="http://text:11434",
        model_fast="Qwen/Qwen3-8B-GGUF:Q4_K_M",
        model_thinking="Qwen/Qwen3-14B-GGUF:Q4_K_M",
        vision_model="Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M",
        vision_endpoint="http://vision:11435",
    )


def _install_transport(provider: HTTPProvider, handler) -> None:
    transport = httpx.MockTransport(handler)
    provider._client = httpx.AsyncClient(  # noqa: SLF001 — test seam
        base_url=provider.spec.endpoint,
        transport=transport,
    )


def _install_vision_transport(
    monkeypatch: pytest.MonkeyPatch, handler
) -> None:
    """When vision_endpoint != endpoint, vision() builds a short-lived client.

    We hook the httpx constructor so we can slot in a MockTransport for
    that separate client too.
    """
    import lokidoki.core.providers.client as module

    real_cls = module.httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)


@pytest.mark.anyio
async def test_vision_encodes_image_as_data_url() -> None:
    """Raw PNG bytes should land as a ``data:image/png;base64,…`` content part."""
    png_bytes = b"\x89PNG\r\n\x1a\nFAKEDATA"
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "a dog"}}]},
        )

    provider = HTTPProvider(_mlx_spec())
    _install_transport(provider, handler)
    try:
        body = await provider.vision(
            model=_mlx_spec().vision_model,
            images=[png_bytes],
            prompt="what is this?",
        )
    finally:
        await provider.close()

    assert captured["path"] == "/v1/chat/completions"
    parts = captured["payload"]["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "what is this?"}
    assert parts[1]["type"] == "image_url"
    url = parts[1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    decoded = base64.b64decode(url.split(",", 1)[1])
    assert decoded == png_bytes
    assert body["choices"][0]["message"]["content"] == "a dog"


@pytest.mark.anyio
async def test_vision_routes_to_vision_endpoint_when_different(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On llama.cpp profiles the request must target the :11435 process."""
    endpoints_hit: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        endpoints_hit.append(f"{request.url.scheme}://{request.url.host}:{request.url.port}")
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "ok"}}]}
        )

    _install_vision_transport(monkeypatch, handler)
    # The text client is unused here but we still swap it so unused calls
    # don't touch the network.
    provider = HTTPProvider(_llama_spec())
    _install_transport(provider, handler)
    try:
        await provider.vision(
            model=_llama_spec().vision_model,
            images=[b"imgdata"],
            prompt="hi",
        )
    finally:
        await provider.close()

    # Exactly one request should have fired — against the vision endpoint.
    assert endpoints_hit == ["http://vision:11435"], endpoints_hit


@pytest.mark.anyio
async def test_vision_uses_text_endpoint_when_shared() -> None:
    """MLX profile: vision_endpoint == endpoint, so no new client is spawned."""
    hits: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(str(request.url))
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "yes"}}]}
        )

    provider = HTTPProvider(_mlx_spec())
    _install_transport(provider, handler)
    try:
        await provider.vision(
            model=_mlx_spec().vision_model,
            images=[b"imgdata"],
            prompt="hi",
        )
    finally:
        await provider.close()

    assert len(hits) == 1
    assert hits[0].startswith("http://text")


@pytest.mark.anyio
async def test_vision_empty_images_raises() -> None:
    provider = HTTPProvider(_mlx_spec())
    try:
        with pytest.raises(ValueError, match="at least one image"):
            await provider.vision(
                model=_mlx_spec().vision_model,
                images=[],
                prompt="hi",
            )
    finally:
        await provider.close()


@pytest.mark.anyio
async def test_vision_non_200_raises_provider_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    provider = HTTPProvider(_mlx_spec())
    _install_transport(provider, handler)
    try:
        with pytest.raises(ProviderError, match="500"):
            await provider.vision(
                model=_mlx_spec().vision_model,
                images=[b"x"],
                prompt="hi",
            )
    finally:
        await provider.close()


@pytest.mark.anyio
async def test_vision_multiple_images_all_encoded() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "ok"}}]}
        )

    provider = HTTPProvider(_mlx_spec())
    _install_transport(provider, handler)
    try:
        await provider.vision(
            model=_mlx_spec().vision_model,
            images=[b"one", b"two", b"three"],
            prompt="describe",
        )
    finally:
        await provider.close()

    parts = captured["payload"]["messages"][0]["content"]
    assert parts[0]["type"] == "text"
    image_parts = parts[1:]
    assert len(image_parts) == 3
    for part in image_parts:
        assert part["type"] == "image_url"
        assert part["image_url"]["url"].startswith("data:image/png;base64,")
