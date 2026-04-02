"""Tests for admin-only debug helpers."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig
from app.debug import debug_logs_payload, is_admin_user, read_log_tail


class DebugTests(unittest.TestCase):
    """Verify admin debug helpers."""

    def test_is_admin_user_matches_bootstrap_admin_username(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            data_dir = root_dir / ".lokidoki"
            data_dir.mkdir(parents=True)
            config_path = data_dir / "bootstrap_config.json"
            config_path.write_text(
                json.dumps({"admin": {"username": "jesse"}}),
                encoding="utf-8",
            )
            app_config = AppConfig(
                root_dir=root_dir,
                data_dir=data_dir,
                bootstrap_config_path=config_path,
                database_path=data_dir / "lokidoki.db",
                ui_dist_dir=root_dir / "app" / "ui" / "dist",
                skills_installed_dir=data_dir / "skills" / "installed",
                skills_builtin_dir=root_dir / "app" / "skills" / "builtins",
                skills_repo_index_path=root_dir / "app" / "skills" / "repository" / "index.json",
                jwt_secret="secret",
            )

            self.assertTrue(is_admin_user({"username": "jesse"}, app_config))
            self.assertFalse(is_admin_user({"username": "someone-else"}, app_config))

    def test_debug_logs_payload_reads_local_log_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir)
            data_dir = root_dir / ".lokidoki"
            data_dir.mkdir(parents=True)
            (data_dir / "app.log").write_text("line-one\nline-two\n", encoding="utf-8")
            app_config = AppConfig(
                root_dir=root_dir,
                data_dir=data_dir,
                bootstrap_config_path=data_dir / "bootstrap_config.json",
                database_path=data_dir / "lokidoki.db",
                ui_dist_dir=root_dir / "app" / "ui" / "dist",
                skills_installed_dir=data_dir / "skills" / "installed",
                skills_builtin_dir=root_dir / "app" / "skills" / "builtins",
                skills_repo_index_path=root_dir / "app" / "skills" / "repository" / "index.json",
                jwt_secret="secret",
            )

            payload = debug_logs_payload(app_config)

            app_section = next(section for section in payload["sections"] if section["key"] == "app")
            self.assertTrue(app_section["exists"])
            self.assertEqual(app_section["path"], str(data_dir / "app.log"))
            self.assertEqual(app_section["lines"][-1], "line-two")

    def test_read_log_tail_returns_empty_for_missing_file(self) -> None:
        self.assertEqual(read_log_tail(Path("/tmp/does-not-exist-lokidoki.log")), [])


if __name__ == "__main__":
    unittest.main()
