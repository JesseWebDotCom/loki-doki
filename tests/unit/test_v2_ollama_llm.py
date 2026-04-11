"""Tests for the v2 Ollama LLM client wiring (Phase 5).

Uses a fake :class:`InferenceClient` factory so the tests never make a
real HTTP call. The factory is installed via
``set_inference_client_factory`` and torn down between tests.
"""
from __future__ import annotations

import pytest

from v2.orchestrator.core import config as v2_config
from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks import llm_fallback
from v2.orchestrator.fallbacks.llm_fallback import llm_synthesize_async
from v2.orchestrator.fallbacks.ollama_client import (
    call_llm,
    set_inference_client_factory,
)


class FakeInferenceClient:
    def __init__(self, response: str = "fake llm reply") -> None:
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
def llm_enabled():
    """Temporarily enable LLM without leaking the flag across tests."""
    object.__setattr__(v2_config.CONFIG, "llm_enabled", True)
    yield
    object.__setattr__(v2_config.CONFIG, "llm_enabled", False)
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
        llm_used=True,
        llm_reason="supporting_context",
    )


@pytest.mark.anyio
async def test_call_llm_uses_injected_factory(llm_enabled):
    fake = FakeInferenceClient(response="hello from fake")
    set_inference_client_factory(lambda: fake)

    reply = await call_llm("test prompt")

    assert reply == "hello from fake"
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["model"] == v2_config.CONFIG.llm_model
    assert call["prompt"] == "test prompt"
    assert call["think"] is False
    assert call["num_predict"] == v2_config.CONFIG.llm_num_predict


def _spec_direct_chat_only(question: str) -> RequestSpec:
    """Build a RequestSpec mirroring the executor's direct_chat path:
    one primary chunk routed to direct_chat with the input echoed
    back as ``output_text``."""
    return RequestSpec(
        trace_id="trace-dc",
        original_request=question,
        chunks=[
            RequestChunkResult(
                text=question,
                role="primary_request",
                capability="direct_chat",
                confidence=0.55,
                success=True,
                result={"output_text": question},
            )
        ],
        llm_used=True,
        llm_reason="direct_chat",
    )


@pytest.mark.anyio
async def test_direct_chat_prompt_asks_question_not_spec_summary(llm_enabled):
    """When the only chunk is direct_chat, the prompt sent to LLM must
    use the conversational template (asking the user's question
    directly), NOT the combine template that asks LLM to summarize a
    RequestSpec — that's the bug that produced
    'The primary request, "do my ring cameras spy on me," was
    successfully processed with the output text...'"""
    fake = FakeInferenceClient(response="Ring cameras can record audio and video; check the privacy settings.")
    set_inference_client_factory(lambda: fake)

    spec = _spec_direct_chat_only("do my ring cameras spy on me")
    response = await llm_synthesize_async(spec)

    assert "Ring cameras" in response.output_text
    assert len(fake.calls) == 1
    sent_prompt = fake.calls[0]["prompt"]
    # The conversational template includes the user-question slot.
    assert "User's question: do my ring cameras spy on me" in sent_prompt
    # The combine template's literal "RequestSpec (JSON):" header (the
    # marker that LLM was being asked to summarize a spec) MUST NOT
    # appear. The direct_chat template *names* "RequestSpec" in its
    # rule list ("never mention RequestSpec…"), so a substring check
    # for the bare word would false-positive.
    assert "RequestSpec (JSON):" not in sent_prompt


def test_build_combine_prompt_uses_combine_template_when_skill_output_present():
    """Skill chunks (e.g. get_current_time + supporting context) must
    still go through the combine template, not the direct_chat one."""
    from v2.orchestrator.fallbacks.llm_fallback import build_combine_prompt

    prompt = build_combine_prompt(_spec_with_supporting_context())
    assert "RequestSpec (JSON):" in prompt
    assert "what time is it" in prompt
    assert "because im late" in prompt
    # Direct-chat marker MUST NOT appear when there's a real skill chunk.
    assert "User's question:" not in prompt


def test_build_combine_prompt_uses_direct_chat_template_for_direct_chat_only():
    from v2.orchestrator.fallbacks.llm_fallback import build_combine_prompt

    prompt = build_combine_prompt(_spec_direct_chat_only("what does json stand for"))
    assert "User's question: what does json stand for" in prompt
    # The combine template's RequestSpec header must NOT be sent.
    assert "RequestSpec (JSON):" not in prompt


@pytest.mark.anyio
async def test_llm_synthesize_async_calls_real_path_when_enabled(llm_enabled):
    fake = FakeInferenceClient(response="It's 3:42 PM and you still have time.")
    set_inference_client_factory(lambda: fake)

    response = await llm_synthesize_async(_spec_with_supporting_context())

    assert response.output_text == "It's 3:42 PM and you still have time."
    # The combine prompt should have been rendered and sent through.
    assert len(fake.calls) == 1
    sent_prompt = fake.calls[0]["prompt"]
    assert "RequestSpec" in sent_prompt
    assert "what time is it" in sent_prompt
    assert "because im late" in sent_prompt


@pytest.mark.anyio
async def test_llm_synthesize_async_degrades_to_stub_on_error(llm_enabled):
    set_inference_client_factory(lambda: ExplodingInferenceClient())

    spec = _spec_with_supporting_context()
    response = await llm_synthesize_async(spec)

    # Stub path: deterministic supporting-context note rather than the
    # raw error reaching the user.
    assert response.output_text  # never empty
    assert "Noted" in response.output_text or "3:42 PM" in response.output_text
    # The reason now includes the underlying exception type + message
    # so the dev tools UI can show *why* the call failed.
    assert spec.llm_reason and "degraded:" in spec.llm_reason
    assert "RuntimeError" in spec.llm_reason


@pytest.mark.anyio
async def test_llm_synthesize_async_uses_stub_when_disabled():
    # No fixture: llm_enabled stays False (default).
    fake = FakeInferenceClient(response="should never be called")
    set_inference_client_factory(lambda: fake)
    try:
        response = await llm_synthesize_async(_spec_with_supporting_context())
        # Stub path used; fake was never called.
        assert fake.calls == []
        assert "3:42 PM" in response.output_text
    finally:
        set_inference_client_factory(None)


@pytest.mark.anyio
async def test_llm_synthesize_async_treats_empty_response_as_failure(llm_enabled):
    fake = FakeInferenceClient(response="   ")
    set_inference_client_factory(lambda: fake)

    spec = _spec_with_supporting_context()
    response = await llm_synthesize_async(spec)

    # Empty LLM reply degrades to stub, not propagated as blank.
    assert response.output_text != ""
    assert spec.llm_reason and "degraded:" in spec.llm_reason
    assert "empty response" in spec.llm_reason
