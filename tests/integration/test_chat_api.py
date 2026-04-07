import pytest
import json
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport
from lokidoki.main import app
from lokidoki.api.routes import chat as chat_route
from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path, monkeypatch):
    """Each chat-api test gets its own MemoryProvider on a tmp DB so we
    never write to the real data/lokidoki.db during the suite."""
    mp = MemoryProvider(db_path=str(tmp_path / "chat_api.db"))
    await mp.initialize()

    async def _get_mp():
        return mp

    monkeypatch.setattr(chat_route, "_memory_provider", mp)
    monkeypatch.setattr(chat_route, "get_memory_provider", _get_mp)
    yield
    await mp.close()


MOCK_DECOMPOSITION_JSON = json.dumps({
    "is_course_correction": False,
    "overall_reasoning_complexity": "fast",
    "short_term_memory": {"sentiment": "curious", "concern": "test"},
    "long_term_memory": [],
    "asks": [
        {
            "ask_id": "ask_001",
            "intent": "direct_chat",
            "distilled_query": "Hello",
            "parameters": {}
        }
    ]
})


def _make_stream(text: str):
    """Build an async generator factory matching InferenceClient.generate_stream."""
    async def _gen(*_a, **_kw):
        for tok in text.split(" "):
            yield tok + " "
    return _gen


@pytest.mark.anyio
async def test_chat_endpoint_returns_sse_stream():
    """Test that POST /api/v1/chat returns an SSE event stream."""
    with patch("lokidoki.api.routes.chat.get_inference_client") as mock_get_client:
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(return_value=MOCK_DECOMPOSITION_JSON)
        mock_client.generate_stream = _make_stream("Hello! How can I help you?")
        mock_get_client.return_value = mock_client

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/api/v1/chat",
                json={"message": "Hello"},
                headers={"Accept": "text/event-stream"},
            )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")

        # Parse SSE events from response body
        events = _parse_sse_events(response.text)
        assert len(events) >= 4

        phases = [e.get("phase") for e in events]
        assert "session" in phases  # PR1: chat route emits session id first
        assert "augmentation" in phases
        assert "decomposition" in phases
        assert "synthesis" in phases


@pytest.mark.anyio
async def test_chat_endpoint_returns_final_response():
    """Test that the SSE stream includes the final synthesized response."""
    with patch("lokidoki.api.routes.chat.get_inference_client") as mock_get_client:
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(return_value=MOCK_DECOMPOSITION_JSON)
        mock_client.generate_stream = _make_stream("The answer is 42.")
        mock_get_client.return_value = mock_client

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/api/v1/chat",
                json={"message": "What is the meaning of life?"},
            )

        events = _parse_sse_events(response.text)
        synthesis_done = [e for e in events if e.get("phase") == "synthesis" and e.get("status") == "done"]
        assert len(synthesis_done) == 1
        assert "The answer is 42." in synthesis_done[0]["data"]["response"]


@pytest.mark.anyio
async def test_chat_endpoint_rejects_empty_message():
    """Test that empty messages are rejected with 422."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post("/api/v1/chat", json={"message": ""})

    assert response.status_code == 422


@pytest.mark.anyio
async def test_chat_memory_endpoint():
    """Test that GET /api/v1/chat/memory returns session memory state."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/chat/memory")

    assert response.status_code == 200
    data = response.json()
    assert "messages" in data
    assert "sentiment" in data
    assert "facts" in data


def _parse_sse_events(body: str) -> list[dict]:
    """Parse SSE event stream body into list of JSON event dicts."""
    events = []
    for line in body.strip().split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events
