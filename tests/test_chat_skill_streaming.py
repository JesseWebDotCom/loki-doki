import unittest
import json
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from app.main import app
from app.deps import get_current_user

class TestChatSkillError(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.mock_user = {"id": "test_user", "display_name": "Test User"}
        app.dependency_overrides[get_current_user] = lambda: self.mock_user

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.chat.connection_scope")
    @patch("app.api.chat.skill_service")
    @patch("app.api.chat.classify_message")
    @patch("app.api.chat.resolve_response_style_policy")
    @patch("app.api.chat.route_message_stream")
    @patch("app.api.chat.chat_store")
    def test_chat_message_stream_with_skill_dict_error(
        self,
        mock_chat_store,
        mock_route_stream,
        mock_resolve_policy,
        mock_classify,
        mock_skill_service,
        mock_conn_scope
    ):
        # Mock connection
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn

        # Mock chat resolution
        mock_chat_store.resolve_chat.return_value = {"id": "chat_123"}
        mock_chat_store.load_chat_history.return_value = []

        # Mock classification
        mock_classify.return_value = MagicMock(request_type="text_chat", route="chat", reason="Direct chat")
        
        # Mock policy
        mock_resolve_policy.return_value = {"style": "balanced"}

        # Mock skill service returning a DICT (which causes the bug)
        skill_execution_dict = {
            "message": {
                "role": "assistant",
                "content": "Skill response",
                "meta": {"some": "meta"}
            },
            "route": {"skill_id": "test", "action": "run"},
            "result": {
                "ok": True,
                "skill_id": "test",
                "action": "run",
                "reply": "Skill response",
                "meta": {"some": "meta"},
                "result": {"data": 123}
            }
        }
        mock_skill_service.inspect_route.return_value = {"skill": "test"}
        mock_skill_service.route_and_execute.return_value = skill_execution_dict

        # Mock character service rendering context to avoid DB hits
        with patch("app.api.chat.character_service") as mock_char_service:
            mock_char_service.build_rendering_context.return_value = MagicMock(
                active_character_id="lokidoki",
                care_profile_id="default",
                character_preferred_response_style="balanced"
            )
            
            # Call the API
            response = self.client.post(
                "/api/chats/message/stream",
                json={"chat_id": "chat_123", "message": "use test skill"}
            )

        # In TestClient, the response body might be empty if the generator crashes
        content = response.content.decode("utf-8")
        print(f"Response content: {content}")
        
        # Now it should be 200 and contain the meta/delta/done events
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "meta"', content)
        self.assertIn('"type": "delta"', content)
        self.assertIn('"type": "done"', content)
        self.assertIn("Skill response", content)

if __name__ == "__main__":
    unittest.main()
