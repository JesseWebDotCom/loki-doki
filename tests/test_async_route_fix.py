import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from app.main import app
from app.deps import get_current_user

class TestChatAsyncRoutes(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.mock_user = {"id": "test_user", "display_name": "Test User", "username": "jesse", "is_admin": True}
        # Override the current user dependency
        app.dependency_overrides[get_current_user] = lambda: self.mock_user

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.chat.connection_scope")
    @patch("app.api.chat.chat_store")
    @patch("app.api.chat.skill_service")
    @patch("app.api.chat.classify_message")
    @patch("app.api.chat.resolve_response_style_policy")
    @patch("app.api.chat.character_service")
    @patch("app.api.chat.build_memory_context")
    @patch("app.api.chat.route_message_stream")
    def test_legacy_stream_route_works(
        self,
        mock_route_stream,
        mock_build_mem,
        mock_char_service,
        mock_resolve_policy,
        mock_classify,
        mock_skill_service,
        mock_chat_store,
        mock_conn_scope
    ):
        """Verify that the /api/chat/stream (legacy) route works and is properly awaited."""
        # Mock connection and context
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn
        
        # Mocking minimal data for the stream
        mock_chat_store.resolve_chat.return_value = {"id": "chat_123"}
        mock_chat_store.load_chat_history.return_value = []
        mock_skill_service.inspect_route.return_value = None
        
        # Mock classification
        from types import SimpleNamespace
        mock_classify.return_value = SimpleNamespace(request_type="text_chat", route="chat", reason="test")
        
        # Mock policy
        mock_resolve_policy.return_value = {"style": "balanced", "debug": {}}
        
        # Mock character service
        mock_char_service.build_rendering_context.return_value = None
        mock_build_mem.return_value = "Context"
        class MockStreamResult:
            def __init__(self):
                self.chunks = ["Hello", " world"]
        
        mock_route_stream.return_value = MockStreamResult()

        # Call the legacy alias
        response = self.client.post(
            "/api/chat/stream",
            json={"chat_id": "chat_123", "message": "Hi"}
        )

        # It should NOT be a 500 error (which would happen if coroutine is not awaited)
        self.assertEqual(response.status_code, 200)
        content = response.content.decode("utf-8")
        self.assertIn('"type": "delta"', content)
        self.assertIn("Hello", content)

    @patch("app.api.chat.connection_scope")
    @patch("app.api.chat.chat_store")
    @patch("app.api.chat.generate_chat_assistant_message")
    def test_retry_smart_route_works(
        self,
        mock_gen_msg,
        mock_chat_store,
        mock_conn_scope
    ):
        """Verify that the /api/chat/retry-smart (legacy) and /api/chats/retry-smart work."""
        # Mock connection
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn
        
        # Mock data
        mock_chat_store.resolve_chat.return_value = {"id": "chat_123"}
        mock_chat_store.load_chat_history.return_value = [
            {"role": "user", "content": "hello"}, 
            {"role": "assistant", "content": "hi"}
        ]
        
        # Mocking the assistant message generation
        mock_gen_msg.return_value = {"role": "assistant", "content": "I am smart now"}

        # Call the direct route
        response = self.client.post(
            "/api/chats/retry-smart",
            json={"chat_id": "chat_123", "assistant_index": 1, "response_style": "balanced"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["assistant_message"]["content"], "I am smart now")

        # Call the legacy alias
        response_alias = self.client.post(
            "/api/chat/retry-smart",
            json={"chat_id": "chat_123", "assistant_index": 1, "response_style": "balanced"}
        )
        self.assertEqual(response_alias.status_code, 200)

if __name__ == "__main__":
    unittest.main()
