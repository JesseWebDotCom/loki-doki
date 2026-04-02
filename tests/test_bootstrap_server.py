"""Tests for bootstrap proxy timeout policy and health payload shape."""

from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.bootstrap.health import evaluate_health
from app.bootstrap.server import BootstrapHandler, proxy_timeout_for_path
from app.providers.types import ProviderSpec


class BootstrapServerTests(unittest.TestCase):
    """Verify media routes and health payload behavior."""

    def test_image_routes_get_longer_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/image/analyze"), 180.0)

    def test_video_routes_get_longer_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/video/analyze"), 180.0)

    def test_document_routes_get_longer_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/document/analyze"), 180.0)

    def test_stream_routes_get_longer_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/chat/stream"), 120.0)

    def test_voice_speak_routes_get_medium_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/voices/speak"), 90.0)

    def test_voice_chat_routes_get_medium_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/voice/chat"), 90.0)

    def test_default_routes_keep_short_timeout(self) -> None:
        self.assertEqual(proxy_timeout_for_path("/api/health"), 30.0)

    @patch("app.bootstrap.server.LOGGER")
    def test_wakeword_detect_logs_are_downgraded_to_debug(self, mock_logger) -> None:
        handler = BootstrapHandler.__new__(BootstrapHandler)
        handler.address_string = lambda: "127.0.0.1"  # type: ignore[method-assign]

        handler.log_message('"%s" %s %s', "POST /api/wakeword/detect HTTP/1.1", "200", "-")

        mock_logger.debug.assert_called_once()
        mock_logger.info.assert_not_called()

    @patch("app.bootstrap.server.LOGGER")
    def test_health_logs_are_downgraded_to_debug(self, mock_logger) -> None:
        handler = BootstrapHandler.__new__(BootstrapHandler)
        handler.address_string = lambda: "127.0.0.1"  # type: ignore[method-assign]

        handler.log_message('"%s" %s %s', "GET /api/health HTTP/1.1", "200", "-")

        mock_logger.debug.assert_called_once()
        mock_logger.info.assert_not_called()

    def test_health_endpoint_includes_launchability_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ui_dist = root / "dist"
            ui_dist.mkdir()
            manager = type(
                "Manager",
                (),
                {
                    "runtime_python": root / "python",
                    "bootstrap_config_path": root / "bootstrap.json",
                    "ui_dist_dir": ui_dist,
                    "profile": "mac",
                    "internal_app_url": "http://127.0.0.1:8008",
                    "_image_models_cached": staticmethod(lambda: True),
                    "is_app_reachable": staticmethod(lambda: False),
                    "get_status": staticmethod(
                        lambda: {
                            "blocking_issues": ["FastAPI app is not running yet."],
                            "can_launch": False,
                        }
                    ),
                },
            )()
            manager.runtime_python.write_text("", encoding="utf-8")
            manager.bootstrap_config_path.write_text("{}", encoding="utf-8")
            providers = {
                "llm_fast": ProviderSpec(name="llm_fast", backend="ollama", model="fast", acceleration="cpu"),
                "llm_thinking": ProviderSpec(name="llm_thinking", backend="ollama", model="thinking", acceleration="cpu"),
                "vision": ProviderSpec(name="vision", backend="ollama", model="vision", acceleration="cpu"),
            }
            with patch("app.bootstrap.health.load_bootstrap_config", return_value={"profile": "mac", "models": {}}):
                with patch("app.bootstrap.health.get_profile_defaults", return_value={}):
                    with patch("app.bootstrap.health.resolve_providers", return_value=providers):
                        with patch("app.bootstrap.health.capability_summary", return_value=[]):
                            payload = evaluate_health(manager)

        self.assertIn("blocking_issues", payload)
        self.assertFalse(payload["can_launch"])

    def test_setup_assets_disable_browser_caching(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "index.html"
            target.write_text("<html></html>", encoding="utf-8")
            handler = BootstrapHandler.__new__(BootstrapHandler)
            recorded_headers: list[tuple[str, str]] = []
            handler.path = "/setup/installer.js"
            handler.wfile = io.BytesIO()
            handler.send_response = lambda _status: None  # type: ignore[method-assign]
            handler.send_header = lambda key, value: recorded_headers.append((key, value))  # type: ignore[method-assign]
            handler.end_headers = lambda: None  # type: ignore[method-assign]

            handler._serve_file(target, "application/javascript; charset=utf-8")

        self.assertIn(("Cache-Control", "no-store, no-cache, must-revalidate"), recorded_headers)
        self.assertIn(("Pragma", "no-cache"), recorded_headers)


if __name__ == "__main__":
    unittest.main()
