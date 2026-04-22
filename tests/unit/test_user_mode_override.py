"""Tests for the ``user_mode_override`` wire contract.

Chunk 13 of the rich-response rollout (see
``docs/rich-response/chunk-13-mode-selection-frontend.md``). Covers:

* The chat endpoint's ``ChatRequest`` accepts the new field.
* Unknown overrides are rejected with 400 + a clear message
  (NOT silently dropped — the user explicitly asked for a mode).
* A legal override flows through ``context`` into
  :func:`lokidoki.orchestrator.core.pipeline_phases._build_envelope`
  where :func:`derive_response_mode` reads it and returns the
  corresponding mode.
* Backward-compat: requests without the field still work and the
  envelope falls back to automatic derivation.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.api.routes.chat import ChatRequest
from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core import memory_singleton
from lokidoki.core import memory_user_ops  # noqa: F401 — registers helpers
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app
from lokidoki.orchestrator.core.pipeline_phases import _build_envelope
from lokidoki.orchestrator.core.types import ExecutionResult
from lokidoki.orchestrator.response.mode import VALID_MODES


# ---------------------------------------------------------------------------
# Pydantic model: accepts + normalizes
# ---------------------------------------------------------------------------


class TestChatRequestModel:
    def test_accepts_each_valid_mode(self):
        for mode in VALID_MODES:
            req = ChatRequest(message="hi", user_mode_override=mode)
            assert req.user_mode_override == mode

    def test_defaults_to_none(self):
        req = ChatRequest(message="hi")
        assert req.user_mode_override is None

    def test_empty_string_is_normalized_to_none(self):
        # The UI may send ``""`` when the toggle sits at auto. The
        # model collapses that to None so the endpoint guard sees a
        # single canonical "no override" shape.
        req = ChatRequest(message="hi", user_mode_override="")
        assert req.user_mode_override is None

    def test_whitespace_only_is_normalized_to_none(self):
        req = ChatRequest(message="hi", user_mode_override="   ")
        assert req.user_mode_override is None

    def test_invalid_value_passes_pydantic_layer(self):
        # Semantic validation happens in the endpoint (so we return
        # 400 instead of Pydantic's 422). The model itself accepts
        # arbitrary strings — the endpoint rejects them.
        req = ChatRequest(message="hi", user_mode_override="bogus")
        assert req.user_mode_override == "bogus"


# ---------------------------------------------------------------------------
# Endpoint-level validation: unknown override -> 400
# ---------------------------------------------------------------------------


@pytest.fixture
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "chat_mode.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("luke")
    memory_singleton.set_memory_provider(mp)

    fake_user = User(
        id=uid, username="luke", role="admin", status="active",
        last_password_auth_at=None,
    )

    async def _override_user():
        return fake_user

    async def _override_memory():
        return mp

    app.dependency_overrides[current_user] = _override_user
    app.dependency_overrides[get_memory] = _override_memory
    yield mp
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


@pytest.mark.anyio
async def test_endpoint_rejects_unknown_mode_with_400(_isolated_memory):
    """Unknown ``user_mode_override`` values are rejected with 400 + clear detail."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/chat",
            json={"message": "hi", "user_mode_override": "ultra"},
        )
    assert response.status_code == 400
    body = response.json()
    assert "ultra" in body["detail"]
    # The error should list the valid modes so the caller can fix it.
    assert any(mode in body["detail"] for mode in VALID_MODES)


@pytest.mark.anyio
async def test_endpoint_accepts_legal_override_shape(_isolated_memory):
    """A legal override passes the 400 guard (the stream itself isn't asserted here)."""
    # We stub the pipeline to short-circuit so we're only asserting
    # the guard returned something other than 400/422 for a known mode.
    # The actual envelope pass-through is covered by
    # ``test_override_flows_through_context_to_envelope`` below.
    from lokidoki.orchestrator.core import streaming as streaming_module

    async def _stub_stream(*_a, **_kw):
        # Yield a minimal synthesis-done frame so the endpoint's
        # persistence path completes normally.
        yield (
            'data: {"phase":"synthesis","status":"done",'
            '"data":{"response":"ok","model":"stub","latency_ms":0}}\n\n'
        )

    original_stream = streaming_module.stream_pipeline_sse
    streaming_module.stream_pipeline_sse = _stub_stream
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/api/v1/chat",
                json={"message": "hi", "user_mode_override": "deep"},
            )
        # The endpoint returns a streaming response; as long as it's
        # not the 400 / 422 guard, the override was accepted.
        assert response.status_code == 200
    finally:
        streaming_module.stream_pipeline_sse = original_stream


# ---------------------------------------------------------------------------
# Override flows through context -> envelope.mode
# ---------------------------------------------------------------------------


def _stub_trace() -> MagicMock:
    trace = MagicMock()
    trace.trace_id = "trace-test"
    return trace


def _stub_request_spec() -> MagicMock:
    spec = MagicMock()
    spec.adapter_sources = []
    spec.media = []
    return spec


def _stub_response(text: str = "hello") -> MagicMock:
    resp = MagicMock()
    resp.output_text = text
    resp.spoken_text = None
    return resp


@pytest.mark.parametrize("override", VALID_MODES)
def test_override_flows_through_context_to_envelope(override):
    """``safe_context["user_mode_override"]`` reaches ``derive_response_mode``.

    This is the chunk-12 ↔ chunk-13 seam: the chat endpoint writes the
    override into ``context``, which is threaded into ``safe_context``
    and read by ``_build_envelope`` — which then returns an envelope
    whose ``mode`` equals the user's pick, regardless of what the
    automatic derivation would have chosen.
    """
    # Decomposition deliberately pointed at a different rule-driven
    # mode (encyclopedic + synthesized would normally yield "rich")
    # so we can tell the override actually won.
    safe_context = {
        "user_mode_override": override,
        "response_shape": "synthesized",
        "route_decomposition": MagicMock(capability_need="encyclopedic"),
    }
    envelope = _build_envelope(
        trace=_stub_trace(),
        request_spec=_stub_request_spec(),
        executions=[],
        response=_stub_response(),
        status="complete",
        safe_context=safe_context,
    )
    assert envelope.mode == override


def test_no_override_allows_automatic_derivation():
    """Without an override, the planner's rules pick the mode."""
    # synthesized + rich-shaped capability -> should derive ``rich``.
    safe_context = {
        "response_shape": "synthesized",
        "route_decomposition": MagicMock(capability_need="encyclopedic"),
    }
    envelope = _build_envelope(
        trace=_stub_trace(),
        request_spec=_stub_request_spec(),
        executions=[
            ExecutionResult(
                chunk_index=0,
                capability="encyclopedic",
                output_text="x",
                success=True,
                handler_name="stub",
            ),
        ],
        response=_stub_response(),
        status="complete",
        safe_context=safe_context,
    )
    assert envelope.mode == "rich"


def test_none_override_allows_automatic_derivation():
    """Explicit ``None`` override is treated like an absent key."""
    safe_context = {
        "user_mode_override": None,
        "response_shape": "synthesized",
        "route_decomposition": MagicMock(capability_need="encyclopedic"),
    }
    envelope = _build_envelope(
        trace=_stub_trace(),
        request_spec=_stub_request_spec(),
        executions=[
            ExecutionResult(
                chunk_index=0,
                capability="encyclopedic",
                output_text="x",
                success=True,
                handler_name="stub",
            ),
        ],
        response=_stub_response(),
        status="complete",
        safe_context=safe_context,
    )
    assert envelope.mode == "rich"


# Keep unused AsyncMock import quiet — the stub stream test imports it
# indirectly via the ``streaming_module`` swap.
_ = AsyncMock
