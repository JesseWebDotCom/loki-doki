"""Tests for local Ollama service management."""

from __future__ import annotations

import logging
import unittest
from unittest.mock import patch

from app.providers.ollama_service import ensure_ollama_models, ensure_ollama_service


class OllamaServiceTests(unittest.TestCase):
    """Verify LokiDoki can recover a local Ollama daemon."""

    @patch("app.providers.ollama_service._probe_ollama", return_value={"ok": True, "detail": "ready"})
    def test_ensure_ollama_service_returns_existing_health(self, _mock_probe) -> None:
        result = ensure_ollama_service("mac", logging.getLogger("test"))

        self.assertTrue(result["ok"])
        self.assertFalse(result["started"])

    @patch("app.providers.ollama_service._wait_for_ollama", return_value={"ok": True, "started": False, "detail": "ready"})
    @patch("app.providers.ollama_service._start_ollama_process")
    @patch("app.providers.ollama_service._ollama_serve_running", return_value=False)
    @patch("app.providers.ollama_service.shutil.which", return_value="/usr/local/bin/ollama")
    @patch("app.providers.ollama_service._probe_ollama", return_value={"ok": False, "detail": "down"})
    def test_ensure_ollama_service_starts_ollama_when_missing(
        self,
        _mock_probe,
        _mock_which,
        _mock_running,
        mock_start,
        _mock_wait,
    ) -> None:
        result = ensure_ollama_service("mac", logging.getLogger("test"))

        self.assertTrue(result["ok"])
        self.assertTrue(result["started"])
        mock_start.assert_called_once()

    def test_ensure_ollama_service_skips_profiles_that_do_not_need_cpu_ollama(self) -> None:
        result = ensure_ollama_service("pi_hailo", logging.getLogger("test"))

        self.assertTrue(result["ok"])
        self.assertFalse(result["started"])

    @patch("app.providers.ollama_service._available_local_models", return_value={"qwen-fast", "gemma"})
    @patch("app.providers.ollama_service.ensure_ollama_endpoint", return_value={"ok": True, "detail": "ready"})
    def test_ensure_ollama_models_returns_cleanly_when_models_exist(
        self,
        _mock_endpoint,
        _mock_models,
    ) -> None:
        result = ensure_ollama_models(["qwen-fast", "gemma"], logging.getLogger("test"))

        self.assertTrue(result["ok"])
        self.assertFalse(result["changed"])

    @patch("app.providers.ollama_service._pull_model")
    @patch("app.providers.ollama_service.shutil.which", return_value="/usr/local/bin/ollama")
    @patch("app.providers.ollama_service._available_local_models", return_value={"gemma"})
    @patch("app.providers.ollama_service.ensure_ollama_endpoint", return_value={"ok": True, "detail": "ready"})
    def test_ensure_ollama_models_pulls_missing_models(
        self,
        _mock_endpoint,
        _mock_models,
        _mock_which,
        mock_pull,
    ) -> None:
        result = ensure_ollama_models(["qwen-fast", "gemma", "qwen-fast"], logging.getLogger("test"))

        self.assertTrue(result["ok"])
        self.assertTrue(result["changed"])
        mock_pull.assert_called_once_with("/usr/local/bin/ollama", "qwen-fast", None)


if __name__ == "__main__":
    unittest.main()
