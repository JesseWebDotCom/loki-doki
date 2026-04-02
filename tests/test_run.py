"""Tests for run.py bootstrap reuse and stale-server recovery."""

from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

from app.bootstrap.server import BootstrapHTTPServer

import run


class RunTests(unittest.TestCase):
    """Verify bootstrap startup control flow."""

    def test_bootstrap_server_uses_daemon_threads_for_fast_shutdown(self) -> None:
        self.assertTrue(BootstrapHTTPServer.daemon_threads)
        self.assertFalse(BootstrapHTTPServer.block_on_close)

    @patch("run.wait_for_port_release", return_value=True)
    @patch("run.os.kill")
    @patch("run.bootstrap_server_pids", return_value=[1458])
    def test_terminate_bootstrap_servers_uses_fast_shutdown(
        self,
        _mock_pids,
        mock_kill,
        _mock_wait_for_port_release,
    ) -> None:
        result = run.terminate_bootstrap_servers()

        self.assertTrue(result)
        mock_kill.assert_called_once_with(1458, run.signal.SIGTERM)

    @patch("run.wait_for_existing_server", return_value=None)
    @patch("run.terminate_bootstrap_servers", return_value=True)
    @patch("run.get_running_status", return_value=None)
    @patch("run.bootstrap_server_pids", return_value=[1458])
    @patch("run.port_is_busy", return_value=True)
    def test_reuse_existing_server_cleans_stale_bootstrap_without_long_wait(
        self,
        _mock_port_busy,
        _mock_pids,
        _mock_running_status,
        mock_terminate,
        _mock_wait_for_existing_server,
    ) -> None:
        args = type("Args", (), {"reinstall": False, "no_browser": True})()

        reused = run.reuse_existing_server(args)

        self.assertFalse(reused)
        mock_terminate.assert_called_once()

    @patch("app.providers.ollama.probe_provider_endpoint", return_value={"ok": False, "detail": "down"})
    @patch("run.LOGGER")
    def test_warn_if_text_provider_unavailable_does_not_block_startup(
        self,
        mock_logger,
        _mock_probe,
    ) -> None:
        run.warn_if_text_provider_unavailable("mac")

        mock_logger.warning.assert_called_once()

    @patch("run.current_bootstrap_signature", return_value="new")
    @patch("run.stored_bootstrap_signature", return_value="old")
    def test_bootstrap_server_is_stale_when_signature_changes(
        self,
        _mock_stored,
        _mock_current,
    ) -> None:
        self.assertTrue(run.bootstrap_server_is_stale())

    @patch("run.open_browser")
    @patch("run.terminate_bootstrap_servers", return_value=True)
    @patch("run.bootstrap_server_is_stale", return_value=True)
    @patch("run.get_running_status", return_value={"ready": True, "setup_required": False, "can_launch": True})
    def test_reuse_existing_server_restarts_stale_bootstrap(
        self,
        _mock_status,
        _mock_stale,
        mock_terminate,
        _mock_open_browser,
    ) -> None:
        args = type("Args", (), {"reinstall": False, "no_browser": True})()

        reused = run.reuse_existing_server(args)

        self.assertFalse(reused)
        mock_terminate.assert_called_once()

    @patch("run.shutil.which", return_value="/usr/local/bin/python3")
    def test_build_command_prefers_cli_python_binary(self, _mock_which) -> None:
        command = run.build_command("mac", reinstall=False)

        self.assertEqual(command[0], sys.executable)
        self.assertEqual(command[1:], ["-m", "app.bootstrap.server", "--profile", "mac"])

    def test_status_can_launch_requires_app_running_when_field_missing(self) -> None:
        status = {"ready": True, "setup_required": False, "app_running": False}

        self.assertFalse(run.status_can_launch(status))

    def test_status_can_launch_prefers_explicit_field(self) -> None:
        status = {"ready": True, "setup_required": False, "app_running": False, "can_launch": True}

        self.assertTrue(run.status_can_launch(status))


if __name__ == "__main__":
    unittest.main()
