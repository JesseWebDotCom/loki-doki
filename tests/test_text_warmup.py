"""Tests for text model warm-up behavior."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.config import AppConfig
from app.providers.types import ProviderSpec
from app.subsystems.text.warmup import warm_text_models


def provider(name: str, endpoint: str, model: str) -> ProviderSpec:
    """Build a provider spec for warm-up tests."""
    return ProviderSpec(
        name=name,
        backend="ollama",
        model=model,
        acceleration="cpu",
        endpoint=endpoint,
    )


class TextWarmupTests(unittest.TestCase):
    """Verify warm-up only primes unique active text providers."""

    def setUp(self) -> None:
        self.app_config = AppConfig(
            root_dir=provider.__globals__["__builtins__"] and __import__("pathlib").Path("."),
            data_dir=__import__("pathlib").Path("."),
            bootstrap_config_path=__import__("pathlib").Path("bootstrap.json"),
            database_path=__import__("pathlib").Path("lokidoki.db"),
            ui_dist_dir=__import__("pathlib").Path("dist"),
            jwt_secret="test-secret",
        )

    @patch("app.subsystems.text.warmup._warm_provider")
    @patch("app.subsystems.text.warmup.runtime_context")
    @patch("app.subsystems.text.warmup.db.connect")
    def test_warm_text_models_dedupes_matching_fast_and_thinking(
        self,
        mock_connect,
        mock_runtime_context,
        mock_warm_provider,
    ) -> None:
        mock_connection = mock_connect.return_value
        mock_runtime_context.return_value = {
            "settings": {"profile": "pi_hailo"},
            "providers": {
                "llm_fast": provider("llm_fast", "http://127.0.0.1:8000", "qwen2.5-instruct:1.5b"),
                "llm_thinking": provider("llm_thinking", "http://127.0.0.1:8000", "qwen2.5-instruct:1.5b"),
            },
        }

        warm_text_models(self.app_config)

        mock_warm_provider.assert_called_once()
        self.assertEqual(mock_warm_provider.call_args.args[0].model, "qwen2.5-instruct:1.5b")
        mock_connection.close.assert_called_once()

    @patch("app.subsystems.text.warmup._warm_provider")
    @patch("app.subsystems.text.warmup.runtime_context")
    @patch("app.subsystems.text.warmup.db.connect")
    def test_warm_text_models_warms_distinct_providers(
        self,
        mock_connect,
        mock_runtime_context,
        mock_warm_provider,
    ) -> None:
        mock_connection = mock_connect.return_value
        mock_runtime_context.return_value = {
            "settings": {"profile": "mac"},
            "providers": {
                "llm_fast": provider("llm_fast", "http://127.0.0.1:11434", "qwen2.5:7b"),
                "llm_thinking": provider("llm_thinking", "http://127.0.0.1:11434", "qwen2.5:14b"),
            },
        }

        warm_text_models(self.app_config)

        self.assertEqual(mock_warm_provider.call_count, 2)
        mock_connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
