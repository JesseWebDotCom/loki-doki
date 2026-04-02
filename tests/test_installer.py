"""Tests for bootstrap installer readiness and runtime repair."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.bootstrap.installer import InstallerManager
from app.config import get_profile_defaults


class InstallerManagerTests(unittest.TestCase):
    """Verify installer readiness is derived from live blocking conditions."""

    def test_get_status_reports_blocking_issues_when_app_is_down(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            self._write_bootstrap_config(root_dir, "mac")
            manager = InstallerManager(root_dir, profile="mac")

            with patch.object(manager, "is_app_reachable", return_value=False):
                with patch(
                    "app.bootstrap.installer.manager.platform_manager.critical_runtime_issues",
                    return_value=[],
                ):
                    status = manager.get_status()

            self.assertFalse(status["can_launch"])
            self.assertIn("FastAPI app is not running yet.", status["blocking_issues"])

    def test_run_pipeline_starts_ollama_and_pulls_models_for_cpu_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            (root_dir / "app" / "ui").mkdir(parents=True, exist_ok=True)
            (root_dir / "requirements-app.txt").write_text("fastapi\n", encoding="utf-8")
            self._write_bootstrap_config(root_dir, "mac")
            manager = InstallerManager(root_dir, profile="mac")
            manager.runtime_python.parent.mkdir(parents=True, exist_ok=True)
            manager.runtime_python.write_text("", encoding="utf-8")
            probe_results = iter([False] * 12 + [True] * 4)

            def fake_reachable() -> bool:
                return next(probe_results, True)

            with patch("app.bootstrap.installer.manager.backend_manager.ensure_runtime"):
                with patch("app.bootstrap.installer.manager.backend_manager.install_backend"):
                    with patch("app.bootstrap.installer.manager.frontend_manager.install_frontend"):
                        with patch("app.bootstrap.installer.manager.frontend_manager.build_frontend"):
                            with patch(
                                "app.bootstrap.installer.manager.ensure_ollama_service",
                                return_value={"ok": True, "started": True, "detail": "ready"},
                            ) as mock_service:
                                with patch(
                                    "app.bootstrap.installer.manager.ensure_ollama_models",
                                    return_value={"ok": True, "changed": True, "detail": "ready"},
                                ) as mock_models:
                                    with patch(
                                        "app.bootstrap.installer.manager.platform_manager.critical_runtime_issues",
                                        return_value=[],
                                    ):
                                        with patch(
                                            "app.bootstrap.installer.manager.backend_manager.start_app",
                                            return_value=object(),
                                        ):
                                            with patch.object(manager, "_wait_for_app_start"):
                                                with patch.object(manager, "is_app_reachable", side_effect=fake_reachable):
                                                    manager._run_pipeline()

            self.assertEqual(manager._state["status"], "ready")
            self.assertTrue(manager._state["can_launch"])
            mock_service.assert_called_once()
            pulled_models = mock_models.call_args_list[0].args[0]
            self.assertIn("qwen2.5:7b-instruct-q4_K_M", pulled_models)
            self.assertIn("qwen2.5:14b-instruct-q4_K_M", pulled_models)
            self.assertIn("gemma3:1b", pulled_models)

    def test_run_pipeline_marks_failed_when_app_never_becomes_reachable(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            (root_dir / "app" / "ui").mkdir(parents=True, exist_ok=True)
            (root_dir / "requirements-app.txt").write_text("fastapi\n", encoding="utf-8")
            self._write_bootstrap_config(root_dir, "mac")
            manager = InstallerManager(root_dir, profile="mac")
            manager.runtime_python.parent.mkdir(parents=True, exist_ok=True)
            manager.runtime_python.write_text("", encoding="utf-8")
            manager.app_log_path.write_text("Traceback: startup exploded\n", encoding="utf-8")

            with patch("app.bootstrap.installer.manager.backend_manager.ensure_runtime"):
                with patch("app.bootstrap.installer.manager.backend_manager.install_backend"):
                    with patch("app.bootstrap.installer.manager.frontend_manager.install_frontend"):
                        with patch("app.bootstrap.installer.manager.frontend_manager.build_frontend"):
                            with patch(
                                "app.bootstrap.installer.manager.ensure_ollama_service",
                                return_value={"ok": True, "started": False, "detail": "ready"},
                            ):
                                with patch(
                                    "app.bootstrap.installer.manager.ensure_ollama_models",
                                    return_value={"ok": True, "changed": False, "detail": "ready"},
                                ):
                                    with patch(
                                        "app.bootstrap.installer.manager.platform_manager.critical_runtime_issues",
                                        return_value=[],
                                    ):
                                        with patch(
                                            "app.bootstrap.installer.manager.backend_manager.start_app",
                                            return_value=object(),
                                        ):
                                            with patch.object(
                                                manager,
                                                "_wait_for_app_start",
                                                side_effect=RuntimeError("Main app failed to start."),
                                            ):
                                                with patch.object(manager, "is_app_reachable", return_value=False):
                                                    manager._run_pipeline()

            self.assertEqual(manager._state["status"], "failed")
            self.assertFalse(manager._state["ready"])
            self.assertFalse(manager._state["can_launch"])
            self.assertIn("Main app failed to start.", manager._state["error"])

    def test_health_warnings_do_not_block_ready_when_runtime_is_good(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            self._write_bootstrap_config(root_dir, "mac")
            manager = InstallerManager(root_dir, profile="mac")

            with patch.object(manager, "is_app_reachable", return_value=True):
                with patch(
                    "app.bootstrap.installer.manager.platform_manager.critical_runtime_issues",
                    return_value=[],
                ):
                    status = manager.get_status()

            self.assertTrue(status["can_launch"])
            self.assertEqual(status["blocking_issues"], [])

    def test_start_install_resets_stale_step_statuses_before_new_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            self._write_bootstrap_config(root_dir, "mac")
            manager = InstallerManager(root_dir, profile="mac")
            manager._state["status"] = "failed"
            manager._state["steps"][-1]["status"] = "done"
            manager._state["steps"][-2]["status"] = "done"
            manager._state["current_step"] = "app"
            manager._state["current_action"] = "LokiDoki is ready."

            with patch.object(manager, "is_app_reachable", return_value=False):
                with patch(
                    "app.bootstrap.installer.manager.platform_manager.critical_runtime_issues",
                    return_value=[],
                ):
                    with patch.object(manager, "_run_pipeline"):
                        status = manager.start_install()

            step_map = {step["id"]: step["status"] for step in status["steps"]}
            self.assertEqual(status["status"], "running")
            self.assertEqual(status["current_step"], "profile")
            self.assertEqual(step_map["app"], "pending")
            self.assertEqual(step_map["setup"], "done")

    def _write_bootstrap_config(self, root_dir: Path, profile: str) -> None:
        data_dir = root_dir / ".lokidoki"
        data_dir.mkdir(parents=True, exist_ok=True)
        config = {"profile": profile, "models": get_profile_defaults(profile)}
        (data_dir / "bootstrap_config.json").write_text(
            json.dumps(config),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
