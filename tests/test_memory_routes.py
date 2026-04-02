"""Tests for Phase 8 memory API routes."""

from __future__ import annotations

import sys
import tempfile
import unittest
import importlib.util
from pathlib import Path
from unittest.mock import patch
from unittest.mock import MagicMock

from fastapi import HTTPException

sys.modules.setdefault("jwt", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())

from app import db
from app.chats import store as chat_store
from app.models.memory import MemorySyncRequest, MemoryWriteRequest

_MEMORY_SPEC = importlib.util.spec_from_file_location(
    "test_memory_routes_module",
    Path(__file__).resolve().parents[1] / "app" / "api" / "memory.py",
)
if _MEMORY_SPEC is None or _MEMORY_SPEC.loader is None:
    raise RuntimeError("Could not load memory route module for tests.")
memory = importlib.util.module_from_spec(_MEMORY_SPEC)
_MEMORY_SPEC.loader.exec_module(memory)


class MemoryRouteTests(unittest.TestCase):
    """Verify scope-based memory route behavior."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self._temp_dir.name) / "lokidoki.db"
        with db.connection_scope(self.database_path) as connection:
            db.initialize_database(connection)
            self.user = db.create_user(connection, "jesse", "Jesse", "hashed")
            self.other_user = db.create_user(connection, "bella", "Bella", "hashed")
            self.chat = chat_store.create_chat(connection, self.user["id"], "Memory route chat")
            self.other_chat = chat_store.create_chat(connection, self.other_user["id"], "Other chat")
        self.admin_user = {**self.user, "is_admin": True}

    def tearDown(self) -> None:
        self._temp_dir.cleanup()

    def _connection_patch(self) -> patch:
        return patch.object(
            memory,
            "connection_scope",
            side_effect=lambda: db.connection_scope(self.database_path),
        )

    def test_write_and_list_person_memory_routes(self) -> None:
        with self._connection_patch():
            written = memory.write_memory_api(
                MemoryWriteRequest(
                    scope="person",
                    key="favorite_color",
                    value="yellow",
                    character_id="pikachu",
                ),
                current_user=self.user,
            )
            listed = memory.list_memory_api(
                scope="person",
                chat_id=None,
                character_id="pikachu",
                current_user=self.user,
            )

        self.assertTrue(written["written"])
        self.assertEqual("favorite_color", listed["memories"][0]["key"])
        self.assertEqual("yellow", listed["memories"][0]["value"])

    def test_session_routes_require_owned_chat(self) -> None:
        with self._connection_patch():
            with self.assertRaises(HTTPException) as missing_chat:
                memory.list_memory_api(
                    scope="session",
                    chat_id=None,
                    character_id=None,
                    current_user=self.user,
                )
            with self.assertRaises(HTTPException) as foreign_chat:
                memory.write_memory_api(
                    MemoryWriteRequest(
                        scope="session",
                        key="turn:00:user",
                        value="Hello",
                        chat_id=str(self.other_chat["id"]),
                    ),
                    current_user=self.user,
                )

        self.assertEqual(400, missing_chat.exception.status_code)
        self.assertEqual(404, foreign_chat.exception.status_code)

    def test_household_routes_require_admin(self) -> None:
        non_admin = {"id": self.user["id"], "username": "non-admin", "is_admin": False}
        with self._connection_patch():
            with self.assertRaises(HTTPException) as exc:
                memory.write_memory_api(
                    MemoryWriteRequest(
                        scope="household",
                        key="pet",
                        value="Biscuit",
                    ),
                    current_user=non_admin,
                )

        self.assertEqual(403, exc.exception.status_code)

    def test_delete_route_removes_scoped_memory(self) -> None:
        with self._connection_patch():
            memory.write_memory_api(
                MemoryWriteRequest(
                    scope="person",
                    key="favorite_food",
                    value="pizza",
                    character_id="pikachu",
                ),
                current_user=self.user,
            )
            deleted = memory.delete_memory_api(
                scope="person",
                key="favorite_food",
                chat_id=None,
                character_id="pikachu",
                current_user=self.user,
            )

        self.assertEqual([], deleted["memories"])

    def test_sync_route_returns_updates_after_watermark(self) -> None:
        with self._connection_patch():
            memory.write_memory_api(
                MemoryWriteRequest(
                    scope="household",
                    key="pizza_night",
                    value="Tuesday",
                ),
                current_user=self.admin_user,
            )
            response = memory.sync_memory_api(
                MemorySyncRequest(node_id="node-1", watermark=""),
                current_user=self.admin_user,
            )

        self.assertTrue(response["ok"])
        self.assertEqual(1, len(response["delta"]["household_context"]))
        self.assertTrue(response["watermark"])

    def test_context_route_returns_injected_blocks_and_counts(self) -> None:
        with self._connection_patch():
            memory.write_memory_api(
                MemoryWriteRequest(
                    scope="session",
                    key="turn:00:user",
                    value="We are talking about dinner",
                    chat_id=str(self.chat["id"]),
                ),
                current_user=self.user,
            )
            memory.write_memory_api(
                MemoryWriteRequest(
                    scope="person",
                    key="favorite_food",
                    value="pizza",
                    character_id="pikachu",
                ),
                current_user=self.user,
            )
            context = memory.get_memory_context_api(
                chat_id=str(self.chat["id"]),
                character_id="pikachu",
                current_user=self.user,
            )

        self.assertTrue(context["ok"])
        self.assertIn("<session_context>", context["context"]["session"])
        self.assertIn("<memory_context>", context["context"]["long_term"])
        self.assertIn("favorite_food: pizza", context["context"]["combined"])
        self.assertEqual(1, context["stats"]["session_count"])
        self.assertEqual(1, context["stats"]["person_count"])

    def test_context_route_returns_recent_promoted_facts_from_chat_history(self) -> None:
        with db.connection_scope(self.database_path) as connection:
            chat_store.save_chat_history(
                connection,
                self.user["id"],
                str(self.chat["id"]),
                [
                    {"role": "user", "content": 'I just watched "Everybody Loves Raymond" last night.'},
                    {
                        "role": "assistant",
                        "content": "Nice.",
                        "meta": {
                            "memory_debug": {
                                "promoted_facts": [
                                    {
                                        "key": "recently_watched_title",
                                        "value": "Everybody Loves Raymond",
                                        "confidence": 0.96,
                                    }
                                ]
                            }
                        },
                    },
                ],
            )

        with self._connection_patch():
            context = memory.get_memory_context_api(
                chat_id=str(self.chat["id"]),
                character_id=None,
                current_user=self.user,
            )

        self.assertEqual(1, len(context["recent_promoted_facts"]))
        self.assertEqual("recently_watched_title", context["recent_promoted_facts"][0]["key"])

    def test_context_route_returns_recent_memory_activity(self) -> None:
        with self._connection_patch():
            memory.write_memory_api(
                MemoryWriteRequest(
                    scope="person",
                    key="favorite_drink",
                    value="tea",
                    character_id="pikachu",
                ),
                current_user=self.user,
            )
            context = memory.get_memory_context_api(
                chat_id=str(self.chat["id"]),
                character_id="pikachu",
                current_user=self.user,
            )

        self.assertTrue(context["recent_activity"])
        self.assertEqual("person", context["recent_activity"][0]["scope"])
        self.assertEqual("favorite_drink", context["recent_activity"][0]["key"])


if __name__ == "__main__":
    unittest.main()
