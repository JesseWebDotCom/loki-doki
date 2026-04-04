import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock, patch

from app.main import app
from app.deps import get_current_user
from app.classifier import Classification

# Mock user
MOCK_USER = {"id": "test-user", "display_name": "Test User", "is_admin": False}

def override_get_current_user():
    return MOCK_USER

@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = override_get_current_user
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()

@patch("app.api.chat.classify_message")
@patch("app.api.chat.chat_store.resolve_chat")
@patch("app.api.chat.chat_store.load_chat_history")
@patch("app.api.chat.chat_store.append_chat_message")
@patch("app.api.chat.skill_service.inspect_route")
@patch("app.api.chat.character_service.build_rendering_context")
@patch("app.api.chat.build_memory_context")
@patch("app.api.chat.resolve_response_style_policy")
def test_chat_message_stream_api_success(
    mock_resolve_style,
    mock_build_memory,
    mock_build_rendering,
    mock_inspect_route,
    mock_append_msg,
    mock_load_history,
    mock_resolve_chat,
    mock_classify,
    client
):
    # Setup mocks
    mock_classify.return_value = Classification(request_type="general", route="fast_qwen", reason="test")
    mock_resolve_chat.return_value = {"id": "chat-123"}
    mock_load_history.return_value = []
    mock_inspect_route.return_value = None # No skill for this test
    mock_resolve_style.return_value = {"style": "default"}
    
    payload = {
        "chat_id": "chat-123",
        "message": "Hello",
        "performance_profile_id": "fast"
    }
    
    # We need to patch route_message_stream because it tries to call real LLM providers
    with patch("app.api.chat.route_message_stream") as mock_route:
        mock_route.return_value.chunks = ["Hi", " there"]
        
        response = client.post("/api/chats/message/stream", json=payload)
        
        assert response.status_code == 200
        # Check if we got the expected streaming events
        content = response.text
        assert "meta" in content
        assert "delta" in content
        assert "done" in content
        
    # Verify that inspect_route was called (the core of our bug fix)
    # It should be called with history
    mock_inspect_route.assert_called()
    args, kwargs = mock_inspect_route.call_args
    assert "history" in kwargs
