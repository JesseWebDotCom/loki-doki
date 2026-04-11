"""Tests for the v2 Ollama Gemma client wiring (Phase 5).

Uses a fake :class:`InferenceClient` factory so the tests never make a
real HTTP call. The factory is installed via
``set_inference_client_factory`` and torn down between tests.
"""
from __future__ import annotations

import pytest

from v2.orchestrator.core import config as v2_config
from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks import gemma_fallback
from v2.orchestrator.fallbacks.gemma_fallback import gemma_synthesize_async
from v2.orchestrator.fallbacks.ollama_client import (
    call_gemma,
    set_inference_client_factory,
)


class FakeInferenceClient:
    def __init__(self, response: str = "fake gemma reply") -> None:
        self.response = response
        self.calls: list[dict] = []
        self.closed = False

    async def generate(self, **kwargs):
        self.calls.append(kwargs)
        return self.response

    async def close(self):
        self.closed = True


class ExplodingInferenceClient:
    async def generate(self, **kwargs):
        raise RuntimeError("ollama unreachable")

    async def close(self):
        pass


@pytest.fixture
def gemma_enabled():
    """Temporarily enable Gemma without leaking the flag across tests."""
    object.__setattr__(v2_config.CONFIG, "gemma_enabled", True)
    yield
    object.__setattr__(v2_config.CONFIG, "gemma_enabled", False)
    set_inference_client_factory(None)


def _spec_with_supporting_context() -> RequestSpec:
    return RequestSpec(
        trace_id="trace-real",
        original_request="what time is it because im late",
        chunks=[
            RequestChunkResult(
                text="what time is it",
                role="primary_request",
                capability="get_current_time",
                confidence=0.95,
                result={"output_text": "3:42 PM"},
            ),
            RequestChunkResult(
                text="because im late",
                role="supporting_context",
                capability="",
                confidence=0.0,
            ),
        ],
        supporting_context=["because im late"],
        gemma_used=True,
        gemma_reason="supporting_context",
    )


@pytest.mark.anyio
async def test_call_gemma_uses_injected_factory(gemma_enabled):
    fake = FakeInferenceClient(response="hello from fake")
    set_inference_client_factory(lambda: fake)

    reply = await call_gemma("test prompt")

    assert reply == "hello from fake"
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["model"] == v2_config.CONFIG.gemma_model
    assert call["prompt"] == "test prompt"
    assert call["think"] is False
    assert call["num_predict"] == v2_config.CONFIG.gemma_num_predict


@pytest.mark.anyio
async def test_gemma_synthesize_async_calls_real_path_when_enabled(gemma_enabled):
    fake = FakeInferenceClient(response="It's 3:42 PM and you still have time.")
    set_inference_client_factory(lambda: fake)

    response = await gemma_synthesize_async(_spec_with_supporting_context())

    assert response.output_text == "It's 3:42 PM and you still have time."
    # The combine prompt should have been rendered and sent through.
    assert len(fake.calls) == 1
    sent_prompt = fake.calls[0]["prompt"]
    assert "RequestSpec" in sent_prompt
    assert "what time is it" in sent_prompt
    assert "because im late" in sent_prompt


@pytest.mark.anyio
async def test_gemma_synthesize_async_degrades_to_stub_on_error(gemma_enabled):
    set_inference_client_factory(lambda: ExplodingInferenceClient())

    spec = _spec_with_supporting_context()
    response = await gemma_synthesize_async(spec)

    # Stub path: deterministic supporting-context note rather than the
    # raw error reaching the user.
    assert response.output_text  # never empty
    assert "Noted" in response.output_text or "3:42 PM" in response.output_text
    assert spec.gemma_reason and "degraded:gemma_error" in spec.gemma_reason


@pytest.mark.anyio
async def test_gemma_synthesize_async_uses_stub_when_disabled():
    # No fixture: gemma_enabled stays False (default).
    fake = FakeInferenceClient(response="should never be called")
    set_inference_client_factory(lambda: fake)
    try:
        response = await gemma_synthesize_async(_spec_with_supporting_context())
        # Stub path used; fake was never called.
        assert fake.calls == []
        assert "3:42 PM" in response.output_text
    finally:
        set_inference_client_factory(None)


@pytest.mark.anyio
async def test_gemma_synthesize_async_treats_empty_response_as_failure(gemma_enabled):
    fake = FakeInferenceClient(response="   ")
    set_inference_client_factory(lambda: fake)

    spec = _spec_with_supporting_context()
    response = await gemma_synthesize_async(spec)

    # Empty Gemma reply degrades to stub, not propagated as blank.
    assert response.output_text != ""
    assert spec.gemma_reason and "degraded:gemma_error" in spec.gemma_reason
