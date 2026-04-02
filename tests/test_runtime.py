"""Tests for runtime health reporting."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.providers.types import ProviderSpec
from app.runtime import health_payload


class RuntimeHealthTests(unittest.TestCase):
    """Verify health payload status reflects provider failures."""

    @patch("app.runtime.capability_summary")
    @patch("app.runtime.runtime_context")
    def test_health_payload_is_not_ok_when_capabilities_include_error(
        self,
        mock_runtime_context,
        mock_capability_summary,
    ) -> None:
        mock_runtime_context.return_value = {
            "settings": {"profile": "mac", "app_name": "LokiDoki"},
            "providers": {
                "llm_fast": ProviderSpec(
                    name="llm_fast",
                    backend="ollama",
                    model="qwen",
                    acceleration="cpu",
                    endpoint="http://127.0.0.1:11434",
                )
            },
            "models": {},
        }
        mock_capability_summary.return_value = [
            type("Capability", (), {"to_dict": lambda self: {"key": "llm_fast", "status": "error", "detail": "down"}})(),
        ]

        payload = health_payload(object(), object())

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["capabilities"][0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
