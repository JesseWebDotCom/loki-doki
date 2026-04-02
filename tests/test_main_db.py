"""Tests for startup-safe SQLite connection handling."""

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
import sys
from unittest.mock import MagicMock, patch

sys.modules.setdefault("jwt", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())

from app import main


class MainDatabaseTests(unittest.TestCase):
    """Verify main app database lifecycle helpers."""

    def tearDown(self) -> None:
        if hasattr(main.APP.state, "db_ready"):
            delattr(main.APP.state, "db_ready")

    def test_ensure_database_ready_initializes_once(self) -> None:
        mock_context = MagicMock()
        mock_context.__enter__.return_value = object()
        mock_context.__exit__.return_value = None

        with (
            patch("app.main.db.connection_scope", return_value=mock_context) as mock_connection_scope,
            patch("app.main.db.initialize_database") as mock_initialize,
            patch("app.main.skill_service.initialize") as mock_skill_initialize,
            patch("app.main.character_service.initialize") as mock_character_initialize,
            patch("app.main.load_bootstrap_config", return_value={}) as mock_bootstrap,
        ):
            main.ensure_database_ready()
            main.ensure_database_ready()

        mock_connection_scope.assert_called_once_with(main.APP_CONFIG.database_path)
        mock_initialize.assert_called_once()
        mock_skill_initialize.assert_called_once()
        mock_character_initialize.assert_called_once()
        mock_bootstrap.assert_called_once_with(main.APP_CONFIG.bootstrap_config_path)
        self.assertTrue(main.APP.state.db_ready)

    def test_connection_scope_returns_fresh_connections(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            first_connection = main.db.connect(database_path)
            main.db.initialize_database(first_connection)
            first_connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path)
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()

                with main.connection_scope() as first:
                    first.execute("SELECT 1").fetchone()

                with main.connection_scope() as second:
                    second.execute("SELECT 1").fetchone()

                self.assertNotEqual(id(first), id(second))

    def test_skill_shared_context_persists_through_skill_routes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            connection = main.db.connect(database_path)
            main.db.initialize_database(connection)
            user = main.db.create_user(
                connection,
                username="jesse",
                display_name="Jesse",
                password_hash="hashed",
            )
            connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path)
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()
                with main.connection_scope() as install_connection:
                    main.skill_service.install_skill(install_connection, main.APP_CONFIG, "weather")

                updated = main.save_skill_shared_context_api(
                    "weather",
                    main.SkillSharedContextRequest(
                        values={
                            "location": "Milford, CT",
                            "timezone": "America/New_York",
                        }
                    ),
                    current_user=user,
                )
                loaded = main.get_skills(current_user=user)

            weather = next(skill for skill in loaded["installed"] if skill["skill_id"] == "weather")
            self.assertEqual(updated["values"]["location"], "Milford, CT")
            self.assertEqual(updated["values"]["timezone"], "America/New_York")
            self.assertEqual(weather["shared_context"]["location"], "Milford, CT")
            self.assertEqual(weather["shared_context"]["timezone"], "America/New_York")

    def test_skill_account_test_api_returns_result_and_refreshes_skills(self) -> None:
        admin_user = {"id": "admin", "is_admin": True}
        mock_context = MagicMock()
        mock_context.__enter__.return_value = object()
        mock_context.__exit__.return_value = None
        with patch("app.main.connection_scope", return_value=mock_context):
            with patch("app.main.skill_service.test_account_connection", return_value={"ok": True, "status": "ok", "detail": "Connected"}) as mock_test:
                with patch("app.main.skill_service.list_installed_for_user", return_value=[{"skill_id": "home_assistant"}]) as mock_list:
                    payload = main.test_skill_account_api("home_assistant", "acct-1", current_user=admin_user)
        mock_test.assert_called_once()
        mock_list.assert_called_once()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["result"]["status"], "ok")

    def test_handle_pending_skill_clarification_replays_request_with_confirmed_room(self) -> None:
        pending_history = [
            {"role": "user", "content": "set the ceiling fan to 50%"},
            {
                "role": "assistant",
                "content": "Did you mean Living Room Ceiling Fan, or Bedroom Ceiling Fan?",
                "meta": {
                    "skill_result": {
                        "skill": "home_assistant",
                        "action": "set_level",
                        "presentation": {"type": "clarification"},
                        "data": {
                            "original_request": "set the ceiling fan to 50%",
                            "account_label": "Home",
                            "candidates": [
                                {
                                    "entity_id": "fan.living_room_ceiling",
                                    "friendly_name": "Living Room Ceiling Fan",
                                },
                                {
                                    "entity_id": "fan.bedroom_ceiling",
                                    "friendly_name": "Bedroom Ceiling Fan",
                                },
                            ],
                        },
                    }
                },
            },
        ]
        with patch(
            "app.main._generate_chat_assistant_message",
            return_value={"role": "assistant", "content": "Resolved"},
        ) as mock_generate:
            result = main._handle_pending_skill_clarification(
                connection=MagicMock(),
                current_user={"id": "user-1", "display_name": "Jesse"},
                profile="mac",
                history=pending_history,
                providers={"llm_fast": object(), "llm_thinking": object()},
                message="living room",
            )
        self.assertEqual(result, {"role": "assistant", "content": "Resolved"})
        args = mock_generate.call_args.args
        self.assertEqual(args[3], pending_history[:-1])
        self.assertEqual(args[5], "set the ceiling fan to 50% Living Room Ceiling Fan")

    def test_handle_pending_skill_clarification_keeps_asking_when_reply_is_still_ambiguous(self) -> None:
        pending_history = [
            {
                "role": "assistant",
                "content": "Did you mean Living Room Ceiling Fan, or Bedroom Ceiling Fan?",
                "meta": {
                    "skill_result": {
                        "skill": "home_assistant",
                        "action": "set_level",
                        "presentation": {"type": "clarification"},
                        "data": {
                            "original_request": "set the ceiling fan to 50%",
                            "account_label": "Home",
                            "candidates": [
                                {
                                    "entity_id": "fan.living_room_ceiling",
                                    "friendly_name": "Living Room Ceiling Fan",
                                },
                                {
                                    "entity_id": "fan.bedroom_ceiling",
                                    "friendly_name": "Bedroom Ceiling Fan",
                                },
                            ],
                        },
                    }
                },
            }
        ]
        result = main._handle_pending_skill_clarification(
            connection=MagicMock(),
            current_user={"id": "user-1", "display_name": "Jesse"},
            profile="mac",
            history=pending_history,
            providers={"llm_fast": object(), "llm_thinking": object()},
            message="ceiling fan",
        )
        assert result is not None
        self.assertEqual(result["meta"]["skill_result"]["presentation"]["type"], "clarification")
        self.assertIn("Living Room Ceiling Fan", result["content"])
        self.assertIn("Bedroom Ceiling Fan", result["content"])

    def test_admin_user_management_routes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            data_dir = Path(tmpdir) / ".lokidoki"
            data_dir.mkdir(parents=True, exist_ok=True)
            bootstrap_config_path = data_dir / "bootstrap_config.json"
            bootstrap_config_path.write_text('{"admin":{"username":"admin"}}', encoding="utf-8")
            connection = main.db.connect(database_path)
            main.db.initialize_database(connection)
            admin = main.db.create_user(
                connection,
                username="admin",
                display_name="Admin",
                password_hash="hashed",
            )
            target = main.db.create_user(
                connection,
                username="jesse",
                display_name="Jesse",
                password_hash="old-hash",
            )
            connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path, bootstrap_config_path=bootstrap_config_path)
            admin_user = {**admin, "is_admin": True}
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()

                users_before = main.list_admin_users(current_user=admin_user)
                self.assertEqual(len(users_before["users"]), 2)

                role_update = main.update_admin_user_role(
                    target["id"],
                    main.AdminUserRoleRequest(is_admin=True),
                    current_user=admin_user,
                )
                updated_target = next(user for user in role_update["users"] if user["id"] == target["id"])
                self.assertTrue(updated_target["is_admin"])

                password_update = main.update_admin_user_password(
                    target["id"],
                    main.AdminUserPasswordRequest(password="new-password"),
                    current_user=admin_user,
                )
                self.assertTrue(password_update["ok"])

                with main.connection_scope() as verify_connection:
                    stored_target = main.db.get_user_by_id(verify_connection, target["id"])
                self.assertTrue(main.verify_password("new-password", stored_target["password_hash"]))

                delete_result = main.delete_admin_user(target["id"], current_user=admin_user)
                self.assertEqual(len(delete_result["users"]), 1)

    def test_admin_runtime_metrics_route_returns_payload(self) -> None:
        admin_user = {"id": "admin", "is_admin": True}
        with (
            patch("app.main.runtime_context", return_value={"settings": {"app_name": "LokiDoki", "profile": "mac"}}),
            patch("app.main.db.list_users", return_value=[{"id": "1"}, {"id": "2"}]),
            patch("app.main.runtime_metrics_payload", return_value={"system": {"cpu": {}, "memory": {}, "disk": {}}, "processes": [], "storage": [], "resources": []}),
        ):
            payload = main.get_admin_runtime_metrics(current_user=admin_user)

        self.assertEqual(payload["app_name"], "LokiDoki")
        self.assertEqual(payload["profile"], "mac")
        self.assertEqual(payload["processes"], [])
        self.assertEqual(payload["overview"]["nodes_total"], 1)
        self.assertEqual(payload["overview"]["users_total"], 2)

    def test_chat_retry_smart_replaces_target_turn_and_truncates_later_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            connection = main.db.connect(database_path)
            main.db.initialize_database(connection)
            user = main.db.create_user(
                connection,
                username="jesse",
                display_name="Jesse",
                password_hash="hashed",
            )
            main.store.save_chat_history(
                connection,
                user["id"],
                [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "first"},
                    {"role": "user", "content": "try again"},
                    {"role": "assistant", "content": "second"},
                    {"role": "user", "content": "later"},
                    {"role": "assistant", "content": "third"},
                ],
            )
            connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path)
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()

                with (
                    patch("app.main.runtime_context", return_value={"settings": {"profile": "mac"}, "providers": {"llm_thinking": object(), "llm_fast": object()}}),
                    patch(
                        "app.main._generate_chat_assistant_message",
                        return_value={"role": "assistant", "content": "smart retry", "meta": {"execution": {"provider": "llm_thinking"}}},
                    ) as mock_generate,
                ):
                    payload = main.chat_retry_smart(
                        main.SmartRetryRequest(assistant_index=3),
                        current_user=user,
                    )

                self.assertEqual(payload["message"]["content"], "smart retry")
                args = mock_generate.call_args.args
                self.assertEqual(args[5], "try again")
                self.assertEqual(args[3], [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "first"}])
                self.assertTrue(mock_generate.call_args.kwargs["force_smart"])

                with main.connection_scope() as verify_connection:
                    saved_history = main.store.load_chat_history(verify_connection, user["id"])

                self.assertEqual(
                    saved_history,
                    [
                        {"role": "user", "content": "hello"},
                        {"role": "assistant", "content": "first"},
                        {"role": "user", "content": "try again"},
                        {"role": "assistant", "content": "smart retry", "meta": {"execution": {"provider": "llm_thinking"}}},
                    ],
                )

    def test_chat_routes_manage_named_chats_and_active_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            connection = main.db.connect(database_path)
            main.db.initialize_database(connection)
            user = main.db.create_user(
                connection,
                username="jesse",
                display_name="Jesse",
                password_hash="hashed",
            )
            connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path)
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()

                settings = main.get_settings(current_user=user)
                self.assertEqual(len(settings["chats"]), 1)
                self.assertEqual(settings["history"], [])
                initial_chat_id = settings["active_chat_id"]

                created = main.create_chat_api(main.ChatCreateRequest(title="Weekend plans"), current_user=user)
                created_chat_id = created["chat"]["id"]
                self.assertEqual(created["active_chat_id"], created_chat_id)
                self.assertEqual(created["chat"]["title"], "Weekend plans")
                self.assertEqual(created["history"], [])

                renamed = main.rename_chat_api(
                    created_chat_id,
                    main.ChatRenameRequest(title="Weekend project"),
                    current_user=user,
                )
                renamed_chat = next(chat for chat in renamed["chats"] if chat["id"] == created_chat_id)
                self.assertEqual(renamed_chat["title"], "Weekend project")

                selected = main.select_chat_api(initial_chat_id, current_user=user)
                self.assertEqual(selected["active_chat_id"], initial_chat_id)
                self.assertEqual(selected["history"], [])

                deleted = main.delete_chat_api(initial_chat_id, current_user=user)
                self.assertEqual(len(deleted["chats"]), 1)
                self.assertEqual(deleted["active_chat_id"], created_chat_id)

    def test_chat_route_saves_messages_to_requested_chat(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            database_path = Path(tmpdir) / "lokidoki.db"
            connection = main.db.connect(database_path)
            main.db.initialize_database(connection)
            user = main.db.create_user(
                connection,
                username="jesse",
                display_name="Jesse",
                password_hash="hashed",
            )
            default_chat = main.chat_store.ensure_active_chat(connection, user["id"])
            second_chat = main.chat_store.create_chat(connection, user["id"], "Second chat")
            connection.close()

            app_config = replace(main.APP_CONFIG, database_path=database_path)
            with patch.object(main, "APP_CONFIG", app_config):
                if hasattr(main.APP.state, "db_ready"):
                    delattr(main.APP.state, "db_ready")
                main.ensure_database_ready()

                with (
                    patch("app.main.runtime_context", return_value={"settings": {"profile": "mac"}, "providers": {"llm_thinking": object(), "llm_fast": object()}}),
                    patch(
                        "app.main._generate_chat_assistant_message",
                        return_value={"role": "assistant", "content": "reply"},
                    ),
                ):
                    payload = main.chat(
                        main.ChatRequest(message="hello there", chat_id=str(second_chat["id"])),
                        current_user=user,
                    )

                self.assertEqual(payload["message"]["content"], "reply")

                with main.connection_scope() as verify_connection:
                    second_history = main.chat_store.load_chat_history(verify_connection, user["id"], str(second_chat["id"]))
                    default_history = main.chat_store.load_chat_history(verify_connection, user["id"], str(default_chat["id"]))
                    active_chat = main.chat_store.ensure_active_chat(verify_connection, user["id"])

                self.assertEqual(
                    second_history,
                    [
                        {"role": "user", "content": "hello there"},
                        {"role": "assistant", "content": "reply"},
                    ],
                )
                self.assertEqual(default_history, [])
                self.assertEqual(active_chat["id"], second_chat["id"])


if __name__ == "__main__":
    unittest.main()
