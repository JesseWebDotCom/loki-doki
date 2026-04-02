"""Tests for document-analysis API routes."""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())

from app import db, main
from app.classifier import Classification
from app.orchestrator import OrchestratedDocumentResponse
from app.providers.types import ProviderSpec


def provider() -> ProviderSpec:
    """Build a provider spec for route tests."""
    return ProviderSpec(
        name="llm_thinking",
        backend="ollama",
        model="qwen-thinking",
        acceleration="cpu",
        endpoint="http://127.0.0.1:11434",
    )


class DocumentAnalysisRouteTests(unittest.TestCase):
    """Verify document-analysis routes return the shared schema."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        self.bootstrap_config_path = Path(self._temp_dir.name) / "bootstrap_config.json"
        self.app_config = replace(
            main.APP_CONFIG,
            database_path=self.database_path,
            bootstrap_config_path=self.bootstrap_config_path,
        )
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._config_patch = patch.object(main, "APP_CONFIG", self.app_config)
        self._config_patch.start()
        with main.connection_scope() as connection:
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed-password")

    def tearDown(self) -> None:
        self._config_patch.stop()
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")
        self._temp_dir.cleanup()

    @patch("app.main.runtime_context")
    @patch("app.main.route_document_analysis")
    def test_document_analyze_returns_normalized_payload(
        self,
        mock_route_document_analysis,
        mock_runtime_context,
    ) -> None:
        mock_runtime_context.return_value = {
            "settings": {"profile": "mac"},
            "providers": {"llm_thinking": provider()},
        }
        mock_route_document_analysis.return_value = OrchestratedDocumentResponse(
            classification=Classification(
                request_type="document_analysis",
                route="thinking_qwen",
                reason="Uploaded document requested for text analysis.",
            ),
            reply="This document outlines the release plan.",
            provider=provider(),
        )

        response = main.document_analyze(
            main.DocumentAnalysisRequest(
                document_text="hello world",
                prompt="Summarize this",
                filename="plan.md",
            ),
            current_user=self.user,
        )

        self.assertEqual(response["message"]["content"], "This document outlines the release plan.")
        self.assertEqual(response["message"]["meta"]["request_type"], "document_analysis")
        self.assertEqual(response["message"]["meta"]["execution"]["model"], "qwen-thinking")
        mock_route_document_analysis.assert_called_once()
        args = mock_route_document_analysis.call_args.args
        self.assertEqual(args[0], "hello world")
        self.assertEqual(args[1], "Summarize this")
        self.assertEqual(args[2], "plan.md")
        self.assertEqual(args[3], "Jesse")
        self.assertEqual(args[4], "mac")
        self.assertEqual(args[6], {"llm_thinking": provider()})


if __name__ == "__main__":
    unittest.main()
