import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from app.main import app
from app.deps import get_current_user

class TestSkillsApi(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        # Mock admin user
        self.mock_user = {
            "id": "test_admin",
            "display_name": "Test Admin",
            "username": "admin",
            "is_admin": True
        }
        app.dependency_overrides[get_current_user] = lambda: self.mock_user

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.skills.connection_scope")
    @patch("app.api.skills.build_skill_context")
    @patch("app.api.skills.skill_service")
    def test_skill_test_endpoint_returns_correct_fields(
        self,
        mock_skill_service,
        mock_build_context,
        mock_conn_scope
    ):
        """Verify that the /api/skills/test endpoint returns result, timing_ms, and context."""
        # Mock connection
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn
        
        # Mock skill context
        mock_build_context.return_value = {
            "profile": "mac",
            "shared_contexts": {},
            "accounts": {}
        }
        
        from unittest.mock import AsyncMock
        mock_skill_service.route_and_execute = AsyncMock(return_value={
            "ok": True,
            "message": {"content": "test response"},
            "route": {},
            "result": {}
        })

        # Call the endpoint
        response = self.client.post(
            "/api/skills/test",
            json={"message": "hello wikipedia"}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        
        # Verify the required fields for the frontend
        self.assertIn("message", data)
        self.assertIn("route", data)
        self.assertIn("result", data)
        self.assertIn("timing_ms", data)
        self.assertIn("context", data)
        self.assertEqual(data["context"]["profile"], "mac")
        self.assertTrue(data["timing_ms"] >= 0)
        self.assertEqual(data["message"]["content"], "test response")

    @patch("app.api.skills.connection_scope")
    @patch("app.api.skills.build_skill_context")
    @patch("app.api.skills.skill_service")
    def test_skill_test_endpoint_handles_no_match(
        self,
        mock_skill_service,
        mock_build_context,
        mock_conn_scope
    ):
        """Verify that the /api/skills/test endpoint handles a None result (no skill matched)."""
        # Mock connection
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn
        
        # Mock skill context
        mock_build_context.return_value = {
            "profile": "mac",
            "shared_contexts": {},
            "accounts": {}
        }
        
        # Mock skill service returning None (no match)
        from unittest.mock import AsyncMock
        mock_skill_service.route_and_execute = AsyncMock(return_value=None)

        # Call the endpoint
        response = self.client.post(
            "/api/skills/test",
            json={"message": "something completely random"}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        
        # Verify the fallback response
        self.assertIn("message", data)
        self.assertIn("No skill matched", data["message"]["content"])
        self.assertEqual(data["route"]["outcome"], "no_skill")
        self.assertIn("timing_ms", data)
        self.assertIn("context", data)
        
        # Verify the nested context used path for the UI
        self.assertIn("result", data)
        self.assertIn("result", data["result"])
        self.assertIn("context", data["result"]["result"])
        self.assertEqual(data["result"]["result"]["context"]["profile"], "mac")

if __name__ == "__main__":
    unittest.main()
